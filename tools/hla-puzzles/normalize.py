"""Normalize one reported HLA typing string to the current release.

Rules (also stated in harbor/hla-typing-report-normalize/instruction.md):
1. A string listed in Deleted_alleles.txt is deprecated; follow its successor (may be a prefix today).
2. Else a pre-2010 colon-less string is deprecated; convert 2-digit fields to colon form (Cw -> C),
   except a rollover name (A*9201, B*9501, DPB1*0102), whose 2010 colon name is not its digits
   split into pairs: it takes the name Allelelist_history.txt gives the same HLA ID (A*02:101),
   flagged ``legacy_rollover``.
3. Else the string must be an assigned name or a valid lower-resolution prefix in this release.
4. Otherwise it is unresolvable.
Then: members = the full alleles the name identifies; allele_2field = 2-field name + the expression
suffix all members share (if any); g_group = the single shared G group, NONE if none, AMBIGUOUS if mixed.

Reported-typing shorthands accepted as input (each leaves a flag so nothing is converted silently):
- An ``HLA-`` prefix is dropped: the release files carry none, and ``HLA-A*02:01:01:01`` must
  resolve exactly like ``A*02:01:01:01``.
- G and P group names (``A*02:01:01G``, ``DPB1*04:01P``) resolve to themselves with
  ``g_group_name`` / ``p_group_name``; their members are the group's members. NGS reports are
  routinely issued at G-group resolution, so a typing made of G groups must check and match.
- ``A*02:XX`` (the XX code: any allele in the first-field family) resolves to the first-field
  prefix with ``xx_code``.
- ``A*02:01g`` (two-field "lg" notation, py-ard ``lg``) resolves to the two-field prefix with
  ``lg_notation``.
- NMDP multiple allele codes (``A*02:AB``) are recognised but NOT expanded: they need the NMDP
  MAC table, which this build does not load. They return unresolvable with ``mac_code`` so a
  caller can tell "we could not check this" from "this name does not exist".
- The legacy ``Cw`` locus label on a colon-style name (``Cw*07:02``, ``Cw*07:XX``) resolves as
  the ``C`` name with ``deprecated_name``, like the colon-less ``Cw*0702`` always has.
"""
from __future__ import annotations

from imgt import (ImgtReference, ImgtError, split_allele, is_legacy_name, legacy_to_colon,
                                     cw_to_c, MAC_RE, XX_RE, LG_RE, group_parts, strip_prefix)

legacy_to_colon = legacy_to_colon   # re-exported: app.py, lab.py and the tests import it from here

SUFFIXES = "NLSCAQ"


def name_parts(name: str) -> tuple[str, list[str], str]:
    """(locus, fields, suffix-or-group-letter) for an allele name, a prefix, or a G/P group name."""
    try:
        return split_allele(name)
    except ImgtError:
        return group_parts(name)


def _members(ref: ImgtReference, name: str) -> list[str]:
    if ref.exists(name):
        return [name]
    if ref.is_group_name(name):
        return ref.g_members(name) or ref.p_members(name)
    locus, fields, suffix = split_allele(name)
    base = f"{locus}*{':'.join(fields)}"
    m = ref.expand(base)
    if suffix:
        m = [x for x in m if split_allele(x)[2] == suffix]
    return m


def _ok(ref: ImgtReference, cand) -> bool:
    try:
        return bool(cand) and (ref.exists(cand) or ref._valid_prefix(cand))
    except ImgtError:
        return False


def resolve_name(ref: ImgtReference, reported: str):
    """-> (name_or_None, flags:set)"""
    s = strip_prefix(reported)
    flags: set[str] = set()
    c = cw_to_c(s)
    if c is not None:                        # Cw*07:02: the C name, resolved like any reported name
        name, fl = resolve_name(ref, c)
        return name, fl | {"deprecated_name"}
    if MAC_RE.match(s) and not XX_RE.match(s):
        return None, {"mac_code"}
    m = XX_RE.match(s)
    if m:                                    # the first-field prefix, resolved like any reported name
        name, fl = resolve_name(ref, f"{m.group(1)}*{m.group(2)}")
        return name, fl | {"xx_code"}
    m = LG_RE.match(s)
    if m:                                    # the two-field name, resolved like any reported name
        name, fl = resolve_name(ref, f"{m.group(1)}*{m.group(2)}:{m.group(3)}")
        return name, fl | {"lg_notation"}
    if ref.is_group_name(s):
        return s, {"g_group_name" if s.endswith("G") else "p_group_name"}
    if ref.is_deleted(s):
        flags.add("deprecated_name")
        succ = ref.renamed_to(s)
        return (succ, flags) if succ else (None, flags | {"nonexistent_allele"})
    if is_legacy_name(s):                    # A*0201: the colon form, resolved like any reported name
        flags.add("deprecated_name")         # (so a colon form that was itself deleted follows its successor)
        cand = ref.rollover_of(s)            # A*9201 -> A*02:101: the 2010 mapping, not its digits
        if cand is not None:
            flags.add("legacy_rollover")
        else:
            cand = legacy_to_colon(s)
        if cand is None:
            return None, flags | {"nonexistent_allele"}
        name, fl = resolve_name(ref, cand)
        return name, fl | flags
    if _ok(ref, s):
        return s, flags
    return None, flags | {"nonexistent_allele"}


def normalize(ref: ImgtReference, reported: str) -> dict:
    name, flags = resolve_name(ref, reported)
    if name is None:
        return {"allele_2field": "UNRESOLVABLE", "g_group": "UNRESOLVABLE", "flags": ";".join(sorted(flags))}
    members = _members(ref, name)
    if not members:
        return {"allele_2field": "UNRESOLVABLE", "g_group": "UNRESOLVABLE", "flags": ";".join(sorted(flags | {"nonexistent_allele"}))}
    locus, fields, _ = name_parts(name)
    base2 = f"{locus}*{':'.join(fields[:2])}"
    under2 = ref.expand(base2)
    sufs = {split_allele(x)[2] for x in under2}
    two = base2 + (next(iter(sufs)) if len(sufs) == 1 and next(iter(sufs)) else "")
    groups = {ref.g_group(m) for m in members}
    g = (next(iter(groups)) or "NONE") if len(groups) == 1 else "AMBIGUOUS"
    if all(split_allele(m)[2] == "N" for m in members):
        flags.add("null_allele")
    return {"allele_2field": two, "g_group": g, "flags": ";".join(sorted(flags))}
