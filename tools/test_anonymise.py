#!/usr/bin/env python3
"""Tests for anonymise.py. All numbers and addresses below are fake.

Run: python3 -m unittest test_anonymise.py   (from the tools/ folder)
"""
import unittest

from anonymise import anonymise_text

SAMPLE = (
    "02/09/2026, 22:04 - Applicant: hi, my number is +353 87 000 0000\n"
    "02/09/2026, 22:05 - Applicant: or call 087 000 0000, email jane.doe@example.com\n"
    "02/09/2026, 22:06 - Agent: thanks! Rental starts at 200 per week.\n"
    "02/09/2026, 22:07 - Applicant: my friend is +44 7700 900000, JANE.DOE@example.com again\n"
)


class AnonymiseTest(unittest.TestCase):
    def test_phones_and_emails_are_replaced(self):
        out, phones, _, _, emails, _, _ = anonymise_text(SAMPLE)
        self.assertNotIn("87 000 0000", out)
        self.assertNotIn("7700 900000", out)
        self.assertNotIn("example.com", out)
        self.assertIn("PHONE001", out)
        self.assertIn("EMAIL001", out)
        # case-insensitive e-mail: one person, one code
        self.assertEqual(len(emails), 1)

    def test_timestamps_and_prices_survive(self):
        out = anonymise_text(SAMPLE)[0]
        self.assertIn("02/09/2026, 22:04", out)
        self.assertIn("200 per week", out)

    def test_without_country_merge_same_number_gets_two_codes(self):
        phones = anonymise_text(SAMPLE)[1]
        self.assertEqual(len(phones), 3)  # documented limitation

    def test_with_country_merge_same_number_gets_one_code(self):
        phones = anonymise_text(SAMPLE, country_code="353", national_digits=9)[1]
        self.assertEqual(len(phones), 2)

    def test_dates_are_not_phones(self):
        out = anonymise_text("Start date 2026-04-22 or 22.04.2026")[0]
        self.assertIn("2026-04-22", out)
        self.assertIn("22.04.2026", out)


if __name__ == "__main__":
    unittest.main()
