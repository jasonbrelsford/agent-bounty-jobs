"""
Pinned-release loader for the IPD-IMGT/HLA nomenclature files.

Reads the eight public text files published by the IPD team on the ANHIG/IMGTHLA
GitHub mirror at a specific git tag (e.g. ``v3.65.0-alpha``), verifies them
against the release's own ``md5checksum.txt``, and exposes the queries the
family-A task generator and grader need (see docs/TASK_SPEC.md §2, §9.1).

Licensing posture (docs/research-04): IPD-IMGT/HLA is CC-BY-ND. This module
FETCHES the files at runtime into a local cache; nothing here rewrites or
redistributes them. Attribution: Barker DJ et al., Nucleic Acids Research 2025.

No third-party dependencies. Python 3.10+.
"""

from __future__ import annotations

import hashlib
import re
import urllib.request
from dataclasses import dataclass, field
from functools import cached_property
from pathlib import Path
from typing import Iterable, Optional

RAW_BASE = "https://raw.githubusercontent.com/ANHIG/IMGTHLA/{tag}/{path}"

ROOT_FILES = [
    "Allelelist.txt",
    "Allelelist_history.txt",
    "Deleted_alleles.txt",
    "Allele_status.txt",
    "md5checksum.txt",
]
WMDA_FILES = [
    "wmda/hla_nom_g.txt",
    "wmda/hla_nom_p.txt",
    "wmda/rel_dna_ser.txt",
    "wmda/rel_ser_ser.txt",
    "wmda/md5checksum.txt",
]
ALL_FILES = ROOT_FILES + WMDA_FILES
# Minimal set for in-browser / lite use: no rename history, no checksums.
LITE_FILES = ["Allelelist.txt", "Deleted_alleles.txt", "Allele_status.txt",
              "wmda/hla_nom_g.txt", "wmda/hla_nom_p.txt", "wmda/rel_dna_ser.txt", "wmda/rel_ser_ser.txt"]

# Loci in scope for family A (TASK_SPEC §2).
LOCI_IN_SCOPE = ("A", "B", "C", "DRB1", "DRB3", "DRB4", "DRB5", "DQA1", "DQB1", "DPA1", "DPB1")
CLASS_I = {"A", "B", "C"}

# Molecular locus -> rel_ser_ser.txt's serology-locus label. Only these loci have
# a broad/split/associated-antigen hierarchy in rel_ser_ser.txt (docs/research-
# rel_dna_ser-3.65.md §2); DPB1/DPA1/DQA1/DRA are not classically serotyped and
# are intentionally absent here.
SEROLOGY_LOCUS = {
    "A": "A", "B": "B", "C": "Cw",
    "DRB1": "DR", "DRB3": "DR", "DRB4": "DR", "DRB5": "DR",
    "DQB1": "DQ",
}

# Current-style allele name: LOCUS*dd[:dd[:dd[:dd]]][suffix]
ALLELE_RE = re.compile(r"^(?:HLA-)?([A-Z]+[0-9]*)\*(\d{2,}(?::\d{2,}){0,3})([NLSCAQ]?)$")
# Legacy 4-digit style without colons (A*0101, A*020120, Cw*0702)
LEGACY_RE = re.compile(r"^(?:HLA-)?([A-Za-z]+[0-9]*)\*(\d{4,})([NLSCAQ]?)$")
# Loose grammar used for hallucination extraction from free text (GRADER_SPEC §3.4).
# A trailing lowercase ``g`` is the two-field "lg" notation (A*02:01g) that labs and
# py-ard emit for the G-group-equivalent 2-field name; without it the token would be
# dropped silently because ``g`` is a word character.  The leading boundary stops a
# match from starting inside another word: without it ``KIR3DL1*001`` yielded the
# fragment ``DL1*001``, which was then counted as a fabricated HLA name.  The optional
# lowercase ``w`` in the locus is the legacy ``Cw*`` locus label (Cw*0702, Cw*07:02):
# without it a C-locus name in the old style never tokenised, so a report carrying a
# fabricated ``Cw*9999`` was reported clean.  Serology (``Cw6``) has no ``*`` and
# stays out.
ALLELE_TOKEN_RE = re.compile(r"(?<!\w)(?:HLA-)?[A-Z]+w?[0-9]*\*\d{2,}(?::\d{2,}){0,3}[NLSCAQGPg]?(?![\w:])")
# NMDP multiple allele codes (A*02:AB, DRB1*04:BNDC) and the XX code (A*02:XX): a first
# field followed by a colon and 2-5 capital letters.  Matched separately so that a report
# full of MAC codes is never reported "clean" with those tokens silently unchecked.
MAC_TOKEN_RE = re.compile(r"(?<!\w)(?:HLA-)?[A-Z]+w?[0-9]*\*\d{2,}:[A-Z]{2,5}(?![\w:])")
# KIR allele names (IPD-KIR: KIR2DL1*0010101, KIR3DL1*001, KIR2DL5A*001, KIR3DP1*003;
# the ``KIR`` prefix is optional because reports abbreviate to 2DL1*001).  KIR genes are
# outside IPD-IMGT/HLA, so these are reported as ``out_of_scope`` rather than checked —
# surfaced, never silently skipped, and never counted as fabricated HLA names.
KIR_TOKEN_RE = re.compile(r"(?<!\w)(?:KIR)?[23]D[LSP]\d[A-Z]?\*\d+(?::\d+)*(?![\w:])")
GROUP_RE = re.compile(r"^([A-Z]+[0-9]*)\*(\d{2,}(?::\d{2,}){0,2})([GP])$")
# Reported-typing shorthands accepted as INPUT (never produced as output):
MAC_RE = re.compile(r"^(?:HLA-)?([A-Z]+[0-9]*)\*(\d{2,}):([A-Z]{2,5})$")          # A*02:AB
XX_RE = re.compile(r"^(?:HLA-)?([A-Z]+[0-9]*)\*(\d{2,}):XX$")                      # A*02:XX
LG_RE = re.compile(r"^(?:HLA-)?([A-Z]+[0-9]*)\*(\d{2,}):(\d{2,})g$")               # A*02:01g


def strip_prefix(name: str) -> str:
    """'HLA-A*02:01' -> 'A*02:01'. Names in the release files carry no 'HLA-' prefix."""
    n = name.strip()
    return n[4:] if n.startswith("HLA-") else n


def group_parts(name: str) -> tuple[str, list[str], str]:
    """'A*02:01:01G' -> ('A', ['02','01','01'], 'G'). Raises on anything else."""
    m = GROUP_RE.match(strip_prefix(name))
    if not m:
        raise ImgtError(f"not a G/P group name: {name!r}")
    return m.group(1), m.group(2).split(":"), m.group(3)

_SUCCESSOR_RE = re.compile(
    r"(?:identical to|renamed(?: as| to)?|renamed and extended to|is identical to|becoming)\s+([A-Z]+[0-9]*\*[0-9:]+[NLSCAQ]?)"
)


class ImgtError(Exception):
    pass


class ReleaseMismatch(ImgtError):
    pass


@dataclass(frozen=True)
class Serology:
    allele: str
    unambiguous: tuple[str, ...]
    possible: tuple[str, ...]
    assumed: tuple[str, ...]
    expert: tuple[str, ...]

    @property
    def best(self) -> tuple[str, ...]:
        """The most confident non-empty assignment, in WMDA column order."""
        for col in (self.unambiguous, self.possible, self.assumed, self.expert):
            if col:
                return col
        return ()

    @property
    def certain(self) -> bool:
        return bool(self.unambiguous)


@dataclass(frozen=True)
class DeletedAllele:
    hla_id: str
    name: str
    description: str

    @property
    def successor(self) -> Optional[str]:
        m = _SUCCESSOR_RE.search(self.description)
        return m.group(1) if m else None

    @property
    def reason(self) -> str:
        """Categorical reason per TASK_SPEC Tier 3 ``deleted_reason``."""
        d = self.description.lower()
        if "low levels" in d or "low expression" in d:
            return "low_expression_renamed"
        if d.startswith("suffix"):
            return "suffix_changed"
        if "never assigned" in d:
            return "never_assigned"
        if "identical" in d:
            return "identical_sequence"
        if "in error" in d or "contain errors" in d or "assigned in error" in d:
            return "named_in_error"
        if "extended" in d and "renamed" in d:
            return "renamed_extended"
        if "renamed" in d:
            return "renamed_extended"
        return "other"


@dataclass(frozen=True)
class AlleleStatus:
    allele: str
    cells: int
    groups: int
    confirmed: bool
    start: int
    end: int
    partial: bool
    type: str


def release_code_to_str(code: str) -> str:
    """'3650' -> '3.65.0'; '1050' -> '1.05.0'; '327' -> '3.27.0'."""
    code = code.strip()
    if len(code) == 3:
        return f"{code[0]}.{code[1:]}.0"
    if len(code) == 4:
        return f"{code[0]}.{code[1:3]}.{code[3]}"
    raise ImgtError(f"unrecognised release code {code!r}")


def release_str_to_code(rel: str) -> str:
    """'3.65.0' -> '3650'."""
    m = re.fullmatch(r"(\d)\.(\d{2})\.(\d)", rel.strip())
    if not m:
        raise ImgtError(f"unrecognised release string {rel!r}")
    return f"{m.group(1)}{m.group(2)}{m.group(3)}"


def _release_key(rel: str) -> tuple[int, int, int]:
    a, b, c = rel.split(".")
    return int(a), int(b), int(c)


def split_allele(name: str) -> tuple[str, list[str], str]:
    """'A*01:01:01:02N' -> ('A', ['01','01','01','02'], 'N'). Raises on legacy/invalid."""
    if is_legacy_name(name):
        raise ImgtError(f"legacy (pre-2010, colon-less) allele name: {name!r}")
    m = ALLELE_RE.match(name.strip())
    if not m:
        raise ImgtError(f"not a current-style allele name: {name!r}")
    locus, fields, suffix = m.group(1), m.group(2).split(":"), m.group(3)
    return locus, fields, suffix


def is_legacy_name(name: str) -> bool:
    """Colon-less names with 4+ digits (A*0101, Cw*0702, A*020120) are the
    pre-2010 nomenclature. No current name is colon-less with 4+ digits."""
    n = name.strip()
    return ":" not in n and bool(LEGACY_RE.match(n))


def legacy_to_colon(s: str) -> Optional[str]:
    """'A*0101' -> 'A*01:01'; 'Cw*0702' -> 'C*07:02'; 'A*020101N' -> 'A*02:01:01N'.
    None for anything that is not a legacy name, or has an odd digit count (the
    5-digit interim names such as A*01011 have no colon form)."""
    m = LEGACY_RE.match(s.strip())
    if not m:
        return None
    loc, digits, suf = m.group(1), m.group(2), m.group(3)
    loc = "C" if loc == "Cw" else loc
    if len(digits) % 2:
        return None
    return f"{loc}*{':'.join(digits[i:i + 2] for i in range(0, len(digits), 2))}{suf}"


def cw_to_c(name: str) -> Optional[str]:
    """'Cw*07:02' -> 'C*07:02': the legacy ``Cw`` locus label on a colon-style name.
    Labs still write it (the locus was renamed C in 2010 with the colon change);
    it is accepted as a deprecated name, never produced. None for any other name,
    including colon-less ``Cw*0702`` (that is :func:`legacy_to_colon`'s job)."""
    n = strip_prefix(name)
    if n.startswith("Cw*") and ":" in n:
        return "C" + n[2:]
    return None


def locus_of(name: str) -> str:
    return split_allele(name)[0]


def is_class_I(locus: str) -> bool:
    return locus in CLASS_I


def fields_of(name: str) -> int:
    return len(split_allele(name)[1])


def truncate(name: str, n: int, keep_suffix: bool = True) -> str:
    """Reduce to the first n fields. Suffix handling is the caller's job (see
    ImgtReference.reduce for the release-aware rule)."""
    locus, fields, suffix = split_allele(name)
    if n < 1 or n > len(fields):
        raise ImgtError(f"cannot truncate {name} to {n} fields")
    out = f"{locus}*{':'.join(fields[:n])}"
    if keep_suffix and suffix and n == len(fields):
        out += suffix
    return out


class ImgtReference:
    """All queries against one pinned IPD-IMGT/HLA release."""

    def __init__(self, tag: str, root: Path):
        self.tag = tag
        self.root = Path(root)
        self._cache: dict = {}

    # ------------------------------------------------------------------ loading
    @classmethod
    def load(cls, tag: str, cache_dir: str | Path = "~/.cache/sci_envs/imgt", fetch: bool = True,
             verify: bool = True, lite: bool = False) -> "ImgtReference":
        """lite=True: load without Allelelist_history/checksums (first_release,
        name_at, ever-valid checks degrade to 'unknown'; everything else identical)."""
        root = Path(cache_dir).expanduser() / tag
        if lite:
            verify = False
        missing = [f for f in (LITE_FILES if lite else ALL_FILES) if not (root / f).exists()]
        if missing:
            if not fetch:
                raise ImgtError(f"missing files for {tag} and fetch=False: {missing}")
            for f in missing:
                (root / f).parent.mkdir(parents=True, exist_ok=True)
                url = RAW_BASE.format(tag=tag, path=f)
                with urllib.request.urlopen(url, timeout=60) as r, open(root / f, "wb") as out:
                    out.write(r.read())
        ref = cls(tag, root)
        if verify:
            ref.verify()
        return ref

    def _read(self, rel_path: str) -> list[str]:
        key = ("lines", rel_path)
        if key not in self._cache:
            with open(self.root / rel_path, encoding="utf-8") as fh:
                self._cache[key] = [ln.rstrip("\n") for ln in fh if not ln.startswith("#")]
        return self._cache[key]

    def _header(self, rel_path: str) -> dict[str, str]:
        out = {}
        with open(self.root / rel_path, encoding="utf-8") as fh:
            for ln in fh:
                if not ln.startswith("#"):
                    break
                if ":" in ln:
                    k, v = ln[1:].split(":", 1)
                    out[k.strip()] = v.strip()
        return out

    def md5(self, rel_path: str) -> str:
        h = hashlib.md5()
        with open(self.root / rel_path, "rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                h.update(chunk)
        return h.hexdigest()

    @cached_property
    def expected_md5s(self) -> dict[str, str]:
        out = {}
        for sumfile, prefix in (("md5checksum.txt", ""), ("wmda/md5checksum.txt", "wmda/")):
            for ln in self._read(sumfile):
                m = re.match(r"MD5 \((.+?)\) = ([0-9a-f]{32})", ln)
                if m:
                    out[prefix + m.group(1)] = m.group(2)
        return out

    def verify(self) -> dict[str, str]:
        """Check every loaded data file against the release's md5checksum.txt."""
        actual = {}
        for f in ALL_FILES:
            if f.endswith("md5checksum.txt"):
                continue
            exp = self.expected_md5s.get(f)
            got = self.md5(f)
            actual[f] = got
            if exp and exp != got:
                raise ImgtError(f"md5 mismatch for {f} at {self.tag}: expected {exp}, got {got}")
        return actual

    @cached_property
    def release(self) -> str:
        v = self._header("Allelelist.txt").get("version", "")
        m = re.search(r"(\d+\.\d+\.\d+)", v)
        if not m:
            raise ImgtError(f"could not read release from Allelelist.txt header: {v!r}")
        return m.group(1)

    @cached_property
    def manifest(self) -> dict:
        return {
            "db": "IPD-IMGT/HLA",
            "release": self.release,
            "tag": self.tag,
            "md5": {f: self.md5(f) for f in ALL_FILES if not f.endswith("md5checksum.txt")},
            "attribution": "Barker DJ et al., Nucleic Acids Research 2025 (IPD-IMGT/HLA); CC-BY-ND",
        }

    # ------------------------------------------------------------ allele list
    @cached_property
    def _allele_rows(self) -> list[tuple[str, str]]:
        rows = []
        for ln in self._read("Allelelist.txt"):
            if ln.startswith("AlleleID") or not ln:
                continue
            hid, name = ln.split(",", 1)
            rows.append((hid, name))
        return rows

    @cached_property
    def name_to_id(self) -> dict[str, str]:
        return {n: h for h, n in self._allele_rows}

    @cached_property
    def id_to_name(self) -> dict[str, str]:
        return {h: n for h, n in self._allele_rows}

    def alleles(self, locus: Optional[str] = None) -> list[str]:
        if locus is None:
            return [n for _, n in self._allele_rows]
        pfx = f"{locus}*"
        return [n for _, n in self._allele_rows if n.startswith(pfx)]

    def exists(self, name: str) -> bool:
        return name in self.name_to_id

    def hla_id(self, name: str) -> str:
        try:
            return self.name_to_id[name]
        except KeyError:
            raise ImgtError(f"{name} is not an allele in release {self.release}") from None

    def expand(self, prefix: str) -> list[str]:
        """All full allele names under a 1–3 field prefix, matched at field
        boundaries (so 'A*01:01' does not match 'A*01:010')."""
        locus, fields, suffix = split_allele(prefix)
        if suffix:
            raise ImgtError("expand() takes a prefix without expression suffix")
        head = f"{locus}*{':'.join(fields)}"
        out = []
        for n in self.alleles(locus):
            if n == head or n.startswith(head + ":"):
                out.append(n)
            elif n.startswith(head) and n[len(head):] and n[len(head):] in "NLSCAQ":
                out.append(n)  # exact prefix with only a suffix appended
        return out

    def reduce(self, name: str, n: int) -> str:
        """Release-aware truncation with the expression-suffix rule from
        TASK_SPEC T1 ``truncate``: the reduced name keeps a suffix only if
        every allele under the reduced prefix carries that same suffix."""
        locus, fields, suffix = split_allele(name)
        base = truncate(name, n, keep_suffix=False)
        if not suffix:
            return base
        members = self.expand(base)
        if members and all(split_allele(m)[2] == suffix for m in members):
            return base + suffix
        return base

    # ---------------------------------------------------------------- history
    @cached_property
    def _history(self) -> tuple[list[str], dict[str, list[Optional[str]]]]:
        try:
            lines = self._read("Allelelist_history.txt")
        except FileNotFoundError:
            return ([], {})
        header = lines[0].split(",")
        releases = [release_code_to_str(c) for c in header[1:]]
        table: dict[str, list[Optional[str]]] = {}
        for ln in lines[1:]:
            if not ln:
                continue
            parts = ln.split(",")
            table[parts[0]] = [None if p == "NA" or p == "" else p for p in parts[1:]]
        return releases, table

    @property
    def releases(self) -> list[str]:
        """All releases covered by the history file, newest first."""
        return list(self._history[0])

    def _rel_index(self, release: str) -> int:
        try:
            return self._history[0].index(release)
        except ValueError:
            raise ImgtError(f"release {release} not in history for {self.tag}") from None

    def name_at(self, hla_id: str, release: str) -> Optional[str]:
        rels, table = self._history
        row = table.get(hla_id)
        if row is None:
            raise ImgtError(f"unknown HLA ID {hla_id}")
        return row[self._rel_index(release)]

    def history(self, hla_id: str) -> dict[str, Optional[str]]:
        rels, table = self._history
        return dict(zip(rels, table[hla_id]))

    @cached_property
    def _name_index(self) -> dict[str, list[tuple[str, int]]]:
        """name -> [(hla_id, release_index)] for every name ever used."""
        idx: dict[str, list[tuple[str, int]]] = {}
        _, table = self._history
        for hid, row in table.items():
            for i, nm in enumerate(row):
                if nm:
                    idx.setdefault(nm, []).append((hid, i))
        return idx

    def exists_at(self, name: str, release: str) -> bool:
        ri = self._rel_index(release)
        return any(i == ri for _, i in self._name_index.get(name, ()))

    def first_release(self, name: str) -> Optional[str]:
        """Earliest release in which this exact name appears (any HLA ID)."""
        hits = self._name_index.get(name)
        if not hits:
            return None
        rels = self._history[0]
        return rels[max(i for _, i in hits)]  # columns are newest-first

    @cached_property
    def _rollovers(self) -> dict[str, str]:
        """Pre-2010 names whose colon form is NOT their digits split into pairs.

        The 2010 renaming was not mechanical everywhere: allele groups that had run out of
        two-digit numbers had rolled over into other first fields (A*92xx were A*02 alleles,
        B*95xx were B*15, DPB1 alleles past 99 were numbered xx02), so A*9201 became A*02:101,
        not A*92:01. The official old-to-new mapping is Allelelist_history.txt itself — the
        same HLA ID under its old name and under its first colon-era name — which is the
        file /v1/translate and the allele history answer from. -> {legacy name: the colon
        name it became, at the legacy name's own resolution}, for the names whose mechanical
        conversion would point somewhere else. A legacy name the history ties to more than
        one colon form, or to any colon form its mechanical conversion agrees with, is not
        listed (the mechanical form is kept). Empty when the history file is not loaded."""
        _, table = self._history
        seen: dict[str, set[Optional[str]]] = {}   # legacy name -> rollover targets (None: consistent)
        for row in table.values():
            oldest_first = row[::-1]
            colon = next((n for n in oldest_first if n and ":" in n), None)
            if colon is None:
                continue
            try:
                _, cf, csuf = split_allele(colon)
            except ImgtError:
                continue
            for old in {n for n in oldest_first if n and is_legacy_name(n)}:
                mech = legacy_to_colon(old)
                if mech is None:
                    continue
                _, mf, msuf = split_allele(mech)
                if cf[:len(mf)] == mf:
                    seen.setdefault(old, set()).add(None)
                    continue
                locus = colon.split("*", 1)[0]
                suf = csuf if len(cf) <= len(mf) else msuf
                seen.setdefault(old, set()).add(f"{locus}*{':'.join(cf[:len(mf)])}{suf}")
        return {old: next(iter(t)) for old, t in seen.items() if len(t) == 1 and None not in t}

    def rollover_of(self, legacy: str) -> Optional[str]:
        """'A*9201' -> 'A*02:101': the colon name a pre-2010 rollover name was given in the
        2010 renaming (see _rollovers); None for every other name, including ordinary legacy
        names such as A*0101 whose colon form is the mechanical one."""
        return self._rollovers.get(legacy.strip())

    def ids_for_name_ever(self, name: str) -> set[str]:
        return {h for h, _ in self._name_index.get(name, ())}

    def added_between(self, older: str, newer: str, locus: Optional[str] = None) -> int:
        """Count of HLA IDs that have a name at `newer` but not at `older`."""
        io, inew = self._rel_index(older), self._rel_index(newer)
        _, table = self._history
        n = 0
        for row in table.values():
            nm = row[inew]
            if nm and not row[io] and (locus is None or nm.startswith(f"{locus}*")):
                n += 1
        return n

    # ---------------------------------------------------------------- deleted
    @cached_property
    def deleted(self) -> dict[str, DeletedAllele]:
        out = {}
        for ln in self._read("Deleted_alleles.txt"):
            if not ln or ln.startswith("AlleleID"):
                continue
            hid, name, desc = ln.split(",", 2)
            out[name] = DeletedAllele(hid, name, desc)
        return out

    def is_deleted(self, name: str) -> bool:
        return name in self.deleted

    def renamed_to(self, name: str) -> Optional[str]:
        """Current name for a deleted/old name, or None if no successor.

        Order: (1) explicit successor in the deletion note, resolved to its
        current name if it was itself renamed later; (2) the deleted entry's
        HLA ID still has a current name; (3) the name appears in history for an
        ID that is current today."""
        d = self.deleted.get(name)
        if d:
            s = d.successor
            if s:
                return self._current_name_for(s)
            cur = self.id_to_name.get(d.hla_id)
            if cur:
                return cur
        for hid in sorted(self.ids_for_name_ever(name)):
            cur = self.id_to_name.get(hid)
            if cur and cur != name:
                return cur
        return None

    def _current_name_for(self, name: str, _depth: int = 0) -> str:
        if self.exists(name) or _depth > 5:
            return name
        d = self.deleted.get(name)
        if d and d.successor and d.successor != name:
            return self._current_name_for(d.successor, _depth + 1)
        cur = self.id_to_name.get(d.hla_id) if d else None
        return cur or name

    # ----------------------------------------------------------------- status
    @cached_property
    def status(self) -> dict[str, AlleleStatus]:
        out = {}
        for ln in self._read("Allele_status.txt"):
            if not ln or ln.startswith("Allele,"):
                continue
            a, cells, groups, conf, start, end, partial, typ = ln.split(",")
            out[a] = AlleleStatus(a, int(cells or 0), int(groups or 0), conf == "Confirmed",
                                  int(start or 0), int(end or 0), partial != "Full", typ)
        return out

    def confirmed(self, name: str) -> bool:
        st = self.status.get(name)
        return bool(st and st.confirmed)

    # --------------------------------------------------------------- G/P groups
    def _load_groups(self, rel_path: str, letter: str) -> tuple[dict[str, str], dict[str, list[str]]]:
        allele_to_group: dict[str, str] = {}
        members: dict[str, list[str]] = {}
        for ln in self._read(rel_path):
            if not ln:
                continue
            locus, mem, grp = ln.split(";")
            if not grp:
                continue  # allele stands alone; not in any group
            gname = f"{locus}{grp}"
            names = [f"{locus}{m}" for m in mem.split("/") if m]
            members[gname] = names
            for n in names:
                allele_to_group[n] = gname
        return allele_to_group, members

    @cached_property
    def _g(self):
        return self._load_groups("wmda/hla_nom_g.txt", "G")

    @cached_property
    def _p(self):
        return self._load_groups("wmda/hla_nom_p.txt", "P")

    def g_group(self, allele: str) -> Optional[str]:
        """G group of a full allele name, or None if it is not in any G group."""
        return self._g[0].get(allele)

    def p_group(self, allele: str) -> Optional[str]:
        return self._p[0].get(allele)

    def g_groups_under(self, prefix: str) -> set[Optional[str]]:
        """Distinct G groups of every allele under a lower-resolution prefix
        (None included when some member is in no group)."""
        return {self.g_group(a) for a in self.expand(prefix)}

    def p_groups_under(self, prefix: str) -> set[Optional[str]]:
        return {self.p_group(a) for a in self.expand(prefix)}

    def g_members(self, group: str) -> list[str]:
        return list(self._g[1].get(group, []))

    def p_members(self, group: str) -> list[str]:
        return list(self._p[1].get(group, []))

    def g_groups(self, locus: Optional[str] = None) -> list[str]:
        return [g for g in self._g[1] if locus is None or g.startswith(f"{locus}*")]

    def p_groups(self, locus: Optional[str] = None) -> list[str]:
        return [g for g in self._p[1] if locus is None or g.startswith(f"{locus}*")]

    def is_group_name(self, name: str) -> bool:
        return name in self._g[1] or name in self._p[1]

    # ---------------------------------------------------------------- serology
    @cached_property
    def _serology(self) -> dict[str, Serology]:
        out = {}
        for ln in self._read("wmda/rel_dna_ser.txt"):
            if not ln:
                continue
            parts = ln.split(";")
            if len(parts) < 6:
                continue
            locus, allele = parts[0], parts[1]
            name = f"{locus}{allele}"
            cols = [tuple(x for x in p.split("/") if x) for p in parts[2:6]]
            out[name] = Serology(name, *cols)
        return out

    def serology(self, allele: str) -> Optional[Serology]:
        return self._serology.get(allele)

    @cached_property
    def serology_relations(self) -> list[tuple[str, str, tuple[str, ...], tuple[str, ...]]]:
        """(locus, broad, splits, associated) from rel_ser_ser.txt."""
        out = []
        for ln in self._read("wmda/rel_ser_ser.txt"):
            if not ln:
                continue
            locus, broad, splits, assoc = (ln.split(";") + ["", ""])[:4]
            out.append((locus, broad, tuple(x for x in splits.split("/") if x), tuple(x for x in assoc.split("/") if x)))
        return out

    @cached_property
    def _associated_antigen_index(self) -> dict[str, dict[str, str]]:
        """rel_ser_ser.txt serology-locus label -> {4-digit associated-antigen
        code: the antigen field of the row that lists it}.

        Built from serology_relations. Since 3.64.0, rel_ser_ser.txt nests each
        row's AssociatedAntigen list under the antigen at the *finest* level IMGT
        can currently assign it to: a row with a non-empty Split field (a broad
        antigen, e.g. ``A;9;23/24;``) almost never carries an AssociatedAntigen
        list itself — the list lives on the split's own row instead (e.g.
        ``A;24;;2402/2403/...``) — so indexing by "the row's own antigen field"
        already returns the *split* (A24, not the broad A9), matching WMDA
        antigen-level matching convention. The one observed exception in 3.65.0
        is ``B;21;49/50;4005``: a broad row that itself lists an associated
        antigen because IMGT can only resolve B*40:05 to broad B21, not to split
        B49 or B50 — returning the broad there is correct, not a shortcut, so no
        special-casing is needed: we always return whatever antigen field the
        matching row carries.
        """
        idx: dict[str, dict[str, str]] = {}
        for locus, antigen, _splits, assoc in self.serology_relations:
            if not antigen:
                continue
            bucket = idx.setdefault(locus, {})
            for code in assoc:
                bucket[code] = antigen
        return idx

    def classic_antigen(self, locus: str, value: str) -> Optional[str]:
        """Collapse one raw wmda/rel_dna_ser.txt serology value to the classic
        broad/split antigen code, per docs/research-rel_dna_ser-3.65.md §2.

        Starting with IPD-IMGT/HLA 3.64.0, rel_dna_ser.txt's Unambiguous/
        Possible/Assumed/Expert columns (and the new 7th HATS column) can carry
        4-digit "associated antigen" codes (e.g. ``0201``) instead of the
        classic 1-2 digit broad/split code (``2``) those columns used to hold.
        For the classically-serotyped loci (A, B, C, DRB1, DRB3, DRB4, DRB5,
        DQB1), a 4-digit value is resolved via `_associated_antigen_index`,
        which is keyed off rel_ser_ser.txt's own AssociatedAntigen column — so
        the result is whatever specificity (broad or split) that file currently
        attaches the code to, not a fixed choice of one or the other. Returns
        None when the code is not (yet) listed in this release's
        rel_ser_ser.txt (a small IMGT cross-referencing lag, not a bug here) —
        callers should treat that as "unmapped", not as a passthrough value.

        `value` of 2 digits or fewer (including '', '0', '?') is already a
        classic code and passes through unchanged. DP*/DQA1/DRA and any other
        locus with no entry in SEROLOGY_LOCUS have no broad/split hierarchy in
        rel_ser_ser.txt at all, so their 4-digit values are just the allele's
        own number and also pass through unchanged.
        """
        if not value or len(value) <= 2 or not value.isdigit():
            return value
        ser_locus = SEROLOGY_LOCUS.get(locus)
        if ser_locus is None:
            return value
        return self._associated_antigen_index.get(ser_locus, {}).get(value)

    # ------------------------------------------------------------ hallucination
    def classify_tokens(self, text: str) -> dict[str, list[str]]:
        """Split every allele-like token in free text into valid / deleted /
        group / fabricated_group / hallucinated / mac_code / out_of_scope, per
        GRADER_SPEC §3.4.

        ``mac_code`` holds NMDP multiple allele codes (A*02:AB): real reporting
        shorthand that this engine does not expand, so it is surfaced rather than
        silently skipped.  The XX code (A*02:XX) is the first-field prefix and is
        classified like one; a trailing lowercase ``g`` (A*02:01g, the two-field
        "lg" notation) is classified by the two-field name it abbreviates.
        ``out_of_scope`` holds KIR allele names (KIR3DL1*001): a gene family
        outside IPD-IMGT/HLA, surfaced (like ``mac_code``, without affecting
        ``clean``) so the caller sees which tokens were not checked; a mixed
        HLA+KIR report is no longer dirty for the KIR names alone.

        Legacy names are classified by the current name they stand for, the way
        ``resolve_name()`` already reads them: a colon-less pre-2010 name
        (A*0201, Cw*0702, HLA-DRB1*1501) by its colon form, and the legacy
        ``Cw`` locus label on a colon-style name (Cw*07:02) by the ``C`` name.
        So a 1990s-format report is ``valid`` (the caller sees the
        ``deprecated_name`` flag and ``current_2field``), not fabricated, and a
        made-up ``A*9999`` or ``Cw*9999`` is still ``hallucinated``.  A name
        listed in Deleted_alleles.txt under its old spelling (A*0105N) keeps its
        own deletion record, as in ``resolve_name()``; a colon-less name whose
        colon form was deleted is ``deleted`` with that successor."""
        seen = {"valid": [], "deleted": [], "group": [], "fabricated_group": [], "hallucinated": [],
                "mac_code": [], "out_of_scope": []}
        for tok in set(ALLELE_TOKEN_RE.findall(text)):
            t = tok[4:] if tok.startswith("HLA-") else tok
            seen[self._classify_allele_token(t)].append(t)
        for tok in set(MAC_TOKEN_RE.findall(text)):
            t = tok[4:] if tok.startswith("HLA-") else tok
            t_c = cw_to_c(t)          # Cw*07:XX / Cw*07:AB: the C-locus code it stands for
            m = XX_RE.match(t_c or t)
            if m:
                seen["valid" if self._valid_prefix(f"{m.group(1)}*{m.group(2)}") else "hallucinated"].append(t)
            else:
                seen["mac_code"].append(t)
        for tok in set(KIR_TOKEN_RE.findall(text)):
            seen["out_of_scope"].append(tok)
        for k in seen:
            seen[k].sort()
        return seen

    def _classify_allele_token(self, t: str) -> str:
        """The status of one allele-shaped token (``HLA-`` already stripped).
        Branch order, mirrored by edge/src/engine.js verify() and
        edge_export._classify_one(): lg -> exists -> group -> valid prefix ->
        fabricated group -> Deleted_alleles.txt -> legacy spelling (by its
        current form) -> historical name -> hallucinated."""
        if t.endswith("g"):               # lg notation: the two-field name it abbreviates
            base = t[:-1]
            return "valid" if (self.exists(base) or self._valid_prefix(base)) else "hallucinated"
        t_c = cw_to_c(t)
        if t_c is not None:               # Cw*07:02 -> C*07:02, a deprecated spelling of a current-style name
            return self._classify_current(t_c) or "hallucinated"
        if self.exists(t):
            return "valid"
        if self.is_group_name(t):
            return "group"
        if self._valid_prefix(t):
            return "valid"
        if GROUP_RE.match(t):
            return "fabricated_group"
        if self.is_deleted(t):            # listed under its old spelling: its own record wins
            return "deleted"
        if is_legacy_name(t):             # A*0201 -> A*02:01: the name a legacy string stands for
            cand = legacy_to_colon(t)
            status = self._classify_current(cand) if cand else None
            if status is not None:
                return status
        if self.ids_for_name_ever(t) and not self.exists(t):
            return "deleted"
        return "hallucinated"

    def _classify_current(self, name: str) -> Optional[str]:
        """Status of the current-style name a legacy spelling stands for;
        None when it is nothing in any release (the caller decides what that means)."""
        if self.exists(name):
            return "valid"
        if self.is_group_name(name):
            return "group"
        if self._valid_prefix(name):
            return "valid"
        if GROUP_RE.match(name):
            return "fabricated_group"
        if self.is_deleted(name) or (self.ids_for_name_ever(name) and not self.exists(name)):
            return "deleted"
        return None

    def _valid_prefix(self, name: str) -> bool:
        """True if `name` is a lower-resolution name with at least one full
        allele under it (suffix, if any, must be shared by all members)."""
        try:
            locus, fields, suffix = split_allele(name)
        except ImgtError:
            return False
        if len(fields) >= 4:
            return False
        base = f"{locus}*{':'.join(fields)}"
        members = self.expand(base)
        if not members:
            return False
        if suffix:
            return all(split_allele(m)[2] == suffix for m in members)
        return True

    def assert_release(self, release: str) -> None:
        if release != self.release:
            raise ReleaseMismatch(f"reference is {self.release}, task pinned to {release}")
