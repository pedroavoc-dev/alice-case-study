# anonymise.py

Replaces phone numbers and e-mail addresses in a conversation with codes
(`PHONE001`, `EMAIL001`), so a real conversation can become test material
for the agent without carrying personal data.

```
python3 anonymise.py conversation.txt
```

Writes `conversation-anon.txt` next to it. **The original is never
touched** and nothing is overwritten: if the output file already exists,
the program stops and tells you.

At the end it prints a report to the terminal: how many codes, and the
snippet around each replacement (with other long numbers and e-mails
masked), so you can check whether a price or a date was caught by mistake.
Suspicious shapes are flagged with `<- check`. The report is never written
to disk.

By default it **writes no map**, so the result cannot be reversed. With
`--map`, the real-to-code mapping goes to `~/.anonymise-maps/`, created
with permission 600, outside the project folder. That file is personal
data; treat it that way.

Requires Python 3.8+ and nothing else (standard library only).

## Merging national and international spellings

Without knowing the country, `+353 87 000 0000` and `087 000 0000` look
like two different numbers and get two codes. If your conversations come
mostly from one country, tell the tool:

```
python3 anonymise.py conversation.txt --country-code 353 --national-digits 9
```

`--national-digits` is the length of a national number without the trunk
`0`. Only one country can be merged per run.

## What it does not do

- It does **not** anonymise names, addresses or ID documents. Only phone
  and e-mail. Names are the next gap to close (see the main README).
- A 9-digit national ID can be mistaken for a phone number. It still gets
  anonymised, just with the wrong label.
- A price written as a bare run of digits, or with dots (`1.250.000`), can
  be caught as a phone. That is why the report exists.

## Usage rule

Anonymise each conversation **once**; the `-anon` file becomes the source
of truth. New messages go **at the end of the original**, never in the
middle: codes are numbered by order of first appearance, and inserting in
the middle makes `PHONE001` become someone else.

A code only means something inside the same file, in the same version.

## Tests

```
python3 -m unittest test_anonymise.py
```

All data in the tests is fake.
