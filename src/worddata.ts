/**
 * Word boards for the word partner game: themes of four words, each word with
 * two clues that point at it and not at its neighbours. A board takes two
 * words from each of four themes, so every target sits next to a close
 * distractor from its own theme. The clues are what the house partner gives
 * and understands, and what the coach suggests after a round.
 * Every word, clue and theme is checked by tests/words.test.mjs: no clue may
 * contain a word or be contained in one, and no clue is used twice.
 */
export const WORD_THEMES: readonly (readonly [string, readonly (readonly [string, string, string])[]])[] = [
  ["ocean", [["whale", "blubber", "humpback"], ["coral", "reef", "polyp"], ["tide", "ebb", "lunar"], ["squid", "calamari", "ink"]]],
  ["kitchen", [["kettle", "whistle", "boil"], ["whisk", "meringue", "beat"], ["oven", "bake", "preheat"], ["ladle", "soup", "scoop"]]],
  ["space", [["comet", "tail", "halley"], ["orbit", "ellipse", "satellite"], ["nebula", "stardust", "gaseous"], ["rocket", "launch", "thrust"]]],
  ["music", [["violin", "bow", "fiddle"], ["drum", "snare", "rhythm"], ["piano", "keys", "sonata"], ["choir", "hymn", "soprano"]]],
  ["weather", [["thunder", "rumble", "lightning"], ["fog", "mist", "visibility"], ["hail", "pellets", "icy"], ["drought", "parched", "dry"]]],
  ["garden", [["rose", "thorn", "petal"], ["shovel", "dig", "spade"], ["compost", "scraps", "decay"], ["hedge", "trim", "privet"]]],
  ["castle", [["moat", "siege", "ditch"], ["tower", "turret", "tall"], ["knight", "armor", "joust"], ["throne", "king", "reign"]]],
  ["office", [["stapler", "bind", "clip"], ["printer", "toner", "jam"], ["meeting", "agenda", "minutes"], ["cubicle", "partition", "desk"]]],
  ["sports", [["goal", "score", "keeper"], ["referee", "foul", "offside"], ["marathon", "miles", "endurance"], ["trophy", "cup", "champion"]]],
  ["forest", [["owl", "hoot", "nocturnal"], ["moss", "damp", "lichen"], ["pine", "cone", "needle"], ["fern", "frond", "shade"]]],
  ["money", [["coin", "mint", "heads"], ["loan", "interest", "borrow"], ["wallet", "pocket", "cards"], ["budget", "spend", "plan"]]],
  ["medicine", [["bandage", "wound", "wrap"], ["pill", "tablet", "swallow"], ["nurse", "ward", "scrubs"], ["fever", "temperature", "chills"]]],
  ["travel", [["passport", "stamp", "border"], ["suitcase", "pack", "luggage"], ["map", "route", "compass"], ["hotel", "lobby", "reception"]]],
  ["farm", [["tractor", "plow", "diesel"], ["barn", "hayloft", "red"], ["sheep", "wool", "flock"], ["harvest", "reap", "autumn"]]],
  ["computers", [["keyboard", "type", "qwerty"], ["mouse", "click", "cursor"], ["server", "rack", "datacenter"], ["password", "login", "secret"]]],
  ["desert", [["cactus", "prickly", "succulent"], ["camel", "hump", "caravan"], ["dune", "sand", "sahara"], ["oasis", "spring", "palms"]]],
  ["school", [["chalk", "blackboard", "dust"], ["exam", "test", "grade"], ["locker", "combination", "hallway"], ["recess", "playground", "break"]]],
  ["art", [["canvas", "easel", "linen"], ["sculpture", "chisel", "marble"], ["palette", "mixing", "colors"], ["portrait", "face", "likeness"]]],
  ["winter", [["sled", "toboggan", "hill"], ["scarf", "knit", "neck"], ["icicle", "drip", "eaves"], ["blizzard", "whiteout", "snowstorm"]]],
  ["cinema", [["popcorn", "butter", "kernel"], ["ticket", "admission", "stub"], ["trailer", "preview", "teaser"], ["usher", "aisle", "flashlight"]]],
  ["birds", [["eagle", "talon", "soar"], ["penguin", "tuxedo", "waddle"], ["parrot", "mimic", "tropical"], ["crow", "caw", "raven"]]],
  ["tools", [["hammer", "nail", "pound"], ["wrench", "bolt", "plumber"], ["saw", "blade", "lumber"], ["drill", "bore", "chuck"]]],
  ["bakery", [["bread", "loaf", "yeast"], ["croissant", "flaky", "french"], ["donut", "glaze", "hole"], ["muffin", "blueberry", "tray"]]],
  ["ancient", [["pyramid", "pharaoh", "tomb"], ["scroll", "papyrus", "unroll"], ["colosseum", "gladiator", "rome"], ["fossil", "bone", "dinosaur"]]],
  ["circus", [["clown", "nose", "juggle"], ["acrobat", "trapeze", "flip"], ["tent", "bigtop", "stakes"], ["lion", "tamer", "mane"]]],
  ["river", [["bridge", "span", "cross"], ["canoe", "paddle", "portage"], ["waterfall", "cascade", "plunge"], ["delta", "mouth", "silt"]]],
  ["bedtime", [["candle", "wax", "wick"], ["dream", "sleep", "vivid"], ["moon", "crescent", "phase"], ["lantern", "glow", "carry"]]],
  ["fruit", [["lemon", "sour", "zest"], ["banana", "peel", "monkey"], ["grape", "vine", "raisin"], ["cherry", "pit", "stem"]]],
  ["detective", [["fingerprint", "smudge", "whorl"], ["alibi", "excuse", "whereabouts"], ["magnifier", "lens", "enlarge"], ["suspect", "lineup", "accused"]]],
  ["theater", [["curtain", "drape", "encore"], ["script", "lines", "dialogue"], ["mask", "disguise", "comedy"], ["applause", "clap", "ovation"]]],
];
