# Offline English spelling dictionary

`english.txt.gz` contains the union of the English Speller Database's default US,
British -ise, and British -ize plain wordlists. These include inflected forms,
contractions, and common abbreviations, while accepting both British and American
usage. The default dictionaries are deliberately used instead of the larger lists,
which also accept uncommon words that can conceal everyday spelling mistakes.

The files came from the project's official [generated wordlists](https://github.com/en-wl/wordlist-diff).
The exact source revision, URLs, input hashes, and resulting word count are recorded
in [sources.json](sources.json). Words are case-folded, deduplicated, sorted, encoded
as UTF-8, and compressed with a fixed gzip timestamp. The upstream distribution
notice is preserved in [COPYRIGHT](COPYRIGHT).

The app loads this dictionary locally. Personal additions are stored separately in
the notebook, and can be removed without changing the bundled dictionary. Neither
spell checking nor personal additions send text to an external service.
