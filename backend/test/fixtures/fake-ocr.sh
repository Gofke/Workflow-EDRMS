#!/bin/sh
# A stand-in OCR engine for the test suite, with tesseract's interface:
#   fake-ocr <input> <output base> -l <languages>   ->   writes <output base>.txt
#
# Its behaviour is driven by the first bytes of the input, so a spec can ask for
# a successful read, an unreadable page or a failing engine without installing
# a real engine wherever the suite runs.
input="$1"
out="$2"
marker=$(head -c 40 "$input")
case "$marker" in
  *OCR-FAIL*) echo "engine exploded" >&2; exit 3 ;;
  *OCR-HANG*) sleep 30; exit 0 ;;
  *OCR-EMPTY*) printf '   \n' > "$out.txt" ;;
  *) printf 'Ministerie van Justitie en Politie\nInzageverzoek dossier 44\n' > "$out.txt" ;;
esac
exit 0
