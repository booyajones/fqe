# fqe canonical invariants, machine-readable, in the spec-mutate line format.
# Each line: RULE_ID: <expected value>. The selfhost test reads THIS file and
# asserts the code matches. spec-mutate corrupts these numbers and proves a test
# dies (the constants are anchored to the spec, not the other way round).
#
# Canonical Wilson-CI blast-radius thresholds (verdict.js BLAST_RADIUS_THRESHOLDS).
BLAST_OUTBOUND: 0.05
BLAST_MCP_READ: 0.03
BLAST_MCP_WRITE_OR_FINANCIAL: 0.01
