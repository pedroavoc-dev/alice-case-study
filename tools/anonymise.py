#!/usr/bin/env python3
# -*- coding: utf-8 -*-
#
# anonymise.py — replaces phone numbers and e-mail addresses with codes
# (PHONE001, EMAIL001) before a conversation is used as test material.
#
# ------------------------------------------------------------------------
# USAGE RULE
#
# Anonymise each conversation ONCE. The "-anon" file becomes the source of
# truth.
#
# New messages are appended at the END of the original, never in the
# middle. Codes are numbered in order of first appearance: inserting a
# message in the middle renumbers everything and PHONE001 becomes someone
# else.
#
# A code only means something inside the same file, in the same version.
# In another file, PHONE001 is another person.
# ------------------------------------------------------------------------
#
# HOW TO USE
#     python3 anonymise.py conversation.txt
#     python3 anonymise.py conversation.txt --map
#     python3 anonymise.py conversation.txt --country-code 353 --national-digits 9
#
# conversation.txt  ->  conversation-anon.txt   (next to it; the original is
#                                                never touched)
#
# By default NO map is written, so the project folder never holds personal
# data. With --map, the map goes to ~/.anonymise-maps/ (outside the
# project), with permission 600.
#
# KNOWN LIMITATIONS
#   - Catches phone numbers from any country. Without knowing the country
#     you can validate the shape, not the number. A 9-digit national ID can
#     be mistaken for a phone number: it still gets anonymised, just with
#     the wrong label.
#   - The same number written with and without the international prefix
#     (e.g. "+353 87 000 0000" and "087 000 0000") gets two different codes,
#     unless you pass --country-code and --national-digits for that country.
#     Only one country can be merged per run.
#   - Does NOT anonymise names, addresses or ID documents. Only phone and
#     e-mail. Read the report printed at the end of every run.

import argparse
import os
import re
import sys
from datetime import datetime

CONTEXT_WIDTH = 30

# --- e-mail ---------------------------------------------------------------
# Deliberately conservative: user@domain.tld, with subdomains.
RE_EMAIL = re.compile(
    r"(?<![A-Za-z0-9._%+-])"
    r"[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}"
    r"(?![A-Za-z0-9._%+-])"
)

# --- phone ----------------------------------------------------------------
# Optional "+" or "00", then 7 to 15 digits separated by space, dash, dot
# or parentheses (at most 2 separators in a row).
#
# "/" and ":" are NOT separators: that is what stops the WhatsApp export
# timestamp ("02/09/2026, 22:04") from being read as a 12-digit phone.
RE_PHONE = re.compile(
    r"(?<!\w)"
    r"(?:\+|00)?"
    r"\d(?:[ \-.()]{0,2}\d){6,14}"
    r"(?!\w)"
)

# Dates the rule above would catch by mistake: 22.04.2026, 22-04-26,
# 2026-04-22.
RE_DATE = re.compile(
    r"^(?:\d{1,2}[.\-]\d{1,2}[.\-]\d{2,4}|\d{4}[.\-]\d{1,2}[.\-]\d{1,2})$"
)

# In the report context, hide any other long number nearby (the neighbour
# of PHONE001 is often PHONE002).
RE_NEARBY_DIGITS = re.compile(r"\d(?:[ \-.()]{0,2}\d){4,}")


def make_phone_normaliser(country_code=None, national_digits=None):
    """Returns a function that reduces a number to a single key, so the
    different ways of writing the same phone get the same code.

    With country_code and national_digits set, a national number
    (optionally with a leading trunk '0') is rewritten in international
    form. Example with country_code='353', national_digits=9:
    '087 000 0000' and '+353 87 000 0000' -> same key."""
    def normalise(raw):
        digits = re.sub(r"\D", "", raw)
        if digits.startswith("00"):
            digits = digits[2:]
        if country_code and national_digits:
            if len(digits) == national_digits + 1 and digits.startswith("0"):
                digits = country_code + digits[1:]
            elif len(digits) == national_digits:
                digits = country_code + digits
        return digits
    return normalise


def normalise_email(raw):
    return raw.lower()


def mask_digits(raw):
    """Hides the middle, keeping enough of the ends to recognise a price or
    a date that was caught by mistake."""
    d = re.sub(r"\D", "", raw)
    n = len(d)
    if n <= 5:
        return d[:1] + "*" * (n - 1)
    hidden = max(3, n - 7)
    start = (n - hidden + 1) // 2
    end = n - hidden - start
    return d[:start] + "*" * hidden + (d[n - end:] if end else "")


def mask_email(raw):
    local, at, domain = raw.partition("@")
    if not at:
        return raw[:1] + "****"
    return local[:1] + "****@" + domain


def phone_is_valid(raw):
    """Discards what matched the rule but is clearly not a phone."""
    return not RE_DATE.match(raw)


def phone_is_suspicious(raw):
    """Flags for review the shapes where false positives come from.

    1. A bare run of up to 8 digits, no '+' and no separator — the shape of
       a price or an order number, not a phone.
    2. Separated only by dots (1.250.000) — the shape of an amount."""
    digits = re.sub(r"\D", "", raw)
    has_prefix = raw.startswith("+") or raw.startswith("00")
    separators = set(re.findall(r"[ \-.()]", raw))
    if not has_prefix and not separators and len(digits) <= 8:
        return True
    if separators and separators <= {"."}:
        return True
    return False


def sanitise(snippet):
    """Cleans the context before showing it: collapses line breaks and hides
    third-party e-mails and long numbers that appear nearby."""
    snippet = re.sub(r"\s+", " ", snippet)
    snippet = RE_EMAIL.sub(lambda m: mask_email(m.group(0)), snippet)
    snippet = RE_NEARBY_DIGITS.sub(
        lambda m: "*" * len(re.sub(r"\D", "", m.group(0))), snippet
    )
    return snippet


def build_context(text, start, end, masked):
    before = sanitise(text[max(0, start - CONTEXT_WIDTH):start])
    after = sanitise(text[end:end + CONTEXT_WIDTH])
    prefix = "..." if start - CONTEXT_WIDTH > 0 else ""
    suffix = "..." if end + CONTEXT_WIDTH < len(text) else ""
    return prefix + before + masked + after + suffix


def replace(text, regex, label, normalise, mask, validate, suspicious):
    """Swaps every match for its code and returns the new text, the map and
    the list of occurrences for the report."""
    codes = {}    # normalised key -> code
    forms = {}    # normalised key -> spellings found in the text
    occurrences = []

    def swap(m):
        raw = m.group(0)
        if validate is not None and not validate(raw):
            return raw
        key = normalise(raw)
        if key not in codes:
            codes[key] = "%s%03d" % (label, len(codes) + 1)
            forms[key] = []
        if raw not in forms[key]:
            forms[key].append(raw)
        occurrences.append({
            "code": codes[key],
            "context": build_context(text, m.start(), m.end(), mask(raw)),
            "suspicious": suspicious(raw) if suspicious is not None else False,
        })
        return codes[key]

    return regex.sub(swap, text), codes, forms, occurrences


def anonymise_text(text, country_code=None, national_digits=None):
    """Pure function, handy for tests: returns (new_text, phone_codes,
    phone_forms, phone_occurrences, email_codes, email_forms,
    email_occurrences). E-mails go first so their digits are not read as
    phones."""
    text, email_codes, email_forms, email_occ = replace(
        text, RE_EMAIL, "EMAIL", normalise_email, mask_email, None, None
    )
    text, phone_codes, phone_forms, phone_occ = replace(
        text, RE_PHONE, "PHONE", make_phone_normaliser(country_code, national_digits),
        mask_digits, phone_is_valid, phone_is_suspicious
    )
    return text, phone_codes, phone_forms, phone_occ, email_codes, email_forms, email_occ


def output_path(path):
    base, ext = os.path.splitext(path)
    return base + "-anon" + ext


def write_map(source_name, items):
    folder = os.path.join(os.path.expanduser("~"), ".anonymise-maps")
    if not os.path.isdir(folder):
        os.makedirs(folder)
    os.chmod(folder, 0o700)

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    base = os.path.splitext(os.path.basename(source_name))[0]
    target = os.path.join(folder, "%s-map-%s.txt" % (base, stamp))

    lines = [
        "# Anonymisation map for: %s" % source_name,
        "# Generated %s" % datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "#",
        "# THIS FILE CONTAINS REAL PERSONAL DATA. Do not share it, do not copy",
        "# it into the project folder, do not attach it to an e-mail. Delete",
        "# it when you no longer need it.",
        "",
    ]
    for code, key, found in items:
        lines.append("%s\t%s\t%s" % (code, key, " | ".join(found)))
    lines.append("")

    # Create with 600 from the start, not chmod after writing.
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    return target


def check_input(path):
    if not os.path.exists(path):
        return "File does not exist: %s" % path
    if os.path.isdir(path):
        return "That is a folder, not a file: %s" % path
    if not os.access(path, os.R_OK):
        return "No permission to read the file: %s" % path
    return None


def main():
    parser = argparse.ArgumentParser(
        description="Replaces phone numbers and e-mails with codes (PHONE001, EMAIL001).",
        epilog="By default no map is written. Use --map if you need to reverse it.",
    )
    parser.add_argument("file", help="path of the text file to anonymise")
    parser.add_argument(
        "--map",
        action="store_true",
        help="write the real -> code map to ~/.anonymise-maps/ (personal data)",
    )
    parser.add_argument(
        "--country-code",
        help="international prefix used to merge national and international "
             "spellings of the same number, e.g. 353",
    )
    parser.add_argument(
        "--national-digits",
        type=int,
        help="length of a national number without the trunk '0', e.g. 9",
    )
    args = parser.parse_args()

    if bool(args.country_code) != bool(args.national_digits):
        print("Error: --country-code and --national-digits go together.", file=sys.stderr)
        return 1

    source = os.path.abspath(os.path.expanduser(args.file))

    problem = check_input(source)
    if problem:
        print("Error: %s" % problem, file=sys.stderr)
        return 1

    target = output_path(source)
    if os.path.exists(target):
        print("Error: the output file already exists:", file=sys.stderr)
        print("  %s" % target, file=sys.stderr)
        print("Delete or rename it and run again. Nothing is overwritten "
              "unless you say so.", file=sys.stderr)
        return 1

    try:
        with open(source, "r", encoding="utf-8", errors="replace", newline="") as f:
            text = f.read()
    except OSError as err:
        print("Error reading the file: %s" % err, file=sys.stderr)
        return 1

    if "\ufffd" in text:
        print("Warning: the file has non-UTF-8 characters. They were replaced "
              "with U+FFFD in the output.\n")

    (text, phone_codes, phone_forms, phone_occ,
     email_codes, email_forms, email_occ) = anonymise_text(
        text, args.country_code, args.national_digits
    )

    try:
        with open(target, "w", encoding="utf-8", newline="") as f:
            f.write(text)
    except OSError as err:
        print("Error writing the output file: %s" % err, file=sys.stderr)
        return 1

    occurrences = phone_occ + email_occ

    print("Anonymised file:")
    print("  %s" % target)
    print("")
    print("Phones: %d distinct, %d replacements." % (len(phone_codes), len(phone_occ)))
    print("E-mails: %d distinct, %d replacements." % (len(email_codes), len(email_occ)))

    if occurrences:
        print("")
        print("Report — check whether a price or a date was caught by mistake.")
        print("(Printed to the terminal only. Never written to any file.)")
        print("")
        for oc in sorted(occurrences, key=lambda o: o["code"]):
            flag = "   <- check" if oc["suspicious"] else ""
            print("  %-9s %s%s" % (oc["code"], oc["context"], flag))

    if args.map:
        items = []
        for key, code in phone_codes.items():
            items.append((code, key, phone_forms[key]))
        for key, code in email_codes.items():
            items.append((code, key, email_forms[key]))
        try:
            written = write_map(source, items)
        except OSError as err:
            print("\nError writing the map: %s" % err, file=sys.stderr)
            return 1
        print("")
        print("Map written outside the project, readable only by you:")
        print("  %s" % written)
        print("It contains real personal data. Do not share it; delete it when done.")
    else:
        print("")
        print("No map was written. If you need to reverse it, run with --map.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
