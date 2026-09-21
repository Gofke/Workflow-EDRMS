#!/bin/sh
# A stand-in PDF text-layer reader for the test suite, with pdftotext's
# interface:  fake-pdftext <input> <output file>
#
# Driven by a marker in the file, so a spec can ask for a PDF with a text
# layer, one without, or a failing reader, with no poppler installed.
input="$1"
out="$2"
marker=$(head -c 60 "$input")
case "$marker" in
  *PDF-FAIL*) echo "reader exploded" >&2; exit 4 ;;
  *PDF-SCANNED*) printf '\f' > "$out" ;;
  *) printf 'Ministerie van Justitie en Politie\nBesluit 2026-118\n\f' > "$out" ;;
esac
exit 0
