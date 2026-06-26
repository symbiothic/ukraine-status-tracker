#!/usr/bin/env python3
"""
build_locations.py
──────────────────
Scrapes mista.ua to build a name → {oblast, raion} lookup table.
Run once locally, then commit data/locations.json to the repo.
The frontend uses this file to enrich DeepStateMap features with oblast/raion info.

Usage:
    pip install requests beautifulsoup4
    python3 build_locations.py
"""

import json
import time
import re
import sys
import urllib.request
from html.parser import HTMLParser

OUTPUT = 'data/locations.json'

# mista.ua category URLs — all settlement types
CATEGORIES = [
    'міста',
    'селища',
    'села',
]

BASE = 'https://mista.ua'


class TableParser(HTMLParser):
    """Minimal HTML parser to extract table rows from mista.ua."""

    def __init__(self):
        super().__init__()
        self._in_table = False
        self._in_row = False
        self._in_cell = False
        self._cell_idx = 0
        self._row = []
        self._rows = []
        self._depth = 0
        self._a_text = ''
        self._link = ''

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'table':
            self._in_table = True
        if self._in_table and tag == 'tr':
            self._in_row = True
            self._row = []
            self._cell_idx = 0
        if self._in_row and tag in ('td', 'th'):
            self._in_cell = True
            self._cell_text = ''
        if self._in_cell and tag == 'a':
            self._link = attrs.get('href', '')

    def handle_endtag(self, tag):
        if tag == 'table':
            self._in_table = False
        if self._in_table and tag == 'tr' and self._in_row:
            self._rows.append(self._row[:])
            self._in_row = False
        if self._in_row and tag in ('td', 'th'):
            self._row.append(getattr(self, '_cell_text', '').strip())
            self._in_cell = False
            self._cell_idx += 1

    def handle_data(self, data):
        if self._in_cell:
            self._cell_text = getattr(self, '_cell_text', '') + data

    @property
    def rows(self):
        return self._rows


def fetch(url, retries=3):
    headers = {
        'User-Agent': 'Mozilla/5.0 (compatible; ukraine-status-tracker/1.0)',
        'Accept-Language': 'uk,en;q=0.9',
    }
    req = urllib.request.Request(url, headers=headers)
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return r.read().decode('utf-8', errors='replace')
        except Exception as e:
            if attempt == retries - 1:
                raise
            time.sleep(2 ** attempt)


def normalize_name(raw):
    """Strip type prefixes (місто, смт, село, ...) and lowercase."""
    raw = raw.strip()
    raw = re.sub(r'^(місто|місто\s+|смт\s+|смт|село\s+|село|селище\s+|селище|с\.\s*|м\.\s*|смт\.\s*)', '', raw, flags=re.IGNORECASE)
    return raw.strip().lower()


def parse_oblast_raion(cell):
    """
    cell looks like:  'Дніпропетровська   Синельниківський'
    or:               'Київська   Бучанський'
    """
    parts = re.split(r'\s{2,}|\n', cell.strip())
    parts = [p.strip() for p in parts if p.strip()]
    oblast = parts[0] if len(parts) > 0 else ''
    raion  = parts[1] if len(parts) > 1 else ''
    # Normalise
    if oblast and 'область' not in oblast.lower():
        oblast += ' область'
    if raion and 'район' not in raion.lower():
        raion += ' район'
    return oblast, raion


def scrape_category(cat):
    """Scrape all pages of a mista.ua settlement category."""
    results = {}
    page = 1
    while True:
        url = f'{BASE}/Пошук_населених_пунктів/{cat}/?page={page}'
        try:
            html = fetch(url)
        except Exception as e:
            print(f'  Error fetching {url}: {e}')
            break

        parser = TableParser()
        parser.feed(html)

        found = 0
        for row in parser.rows:
            if len(row) < 2:
                continue
            name_cell   = row[0]
            oblast_cell = row[1]

            if not name_cell or not oblast_cell:
                continue

            # Skip header rows
            if 'назва' in name_cell.lower() or 'область' in oblast_cell.lower():
                continue

            normalized = normalize_name(name_cell)
            if not normalized or len(normalized) < 2:
                continue

            oblast, raion = parse_oblast_raion(oblast_cell)

            results[normalized] = {'oblast': oblast, 'raion': raion}
            found += 1

        if found == 0:
            break

        print(f'  [{cat}] page {page}: {found} settlements, total so far: {len(results)}')
        page += 1
        time.sleep(0.5)  # be nice

    return results


def main():
    print('Building location database from mista.ua …')
    db = {}

    for cat in CATEGORIES:
        print(f'\nScraping category: {cat}')
        data = scrape_category(cat)
        db.update(data)
        print(f'  → {len(data)} entries')

    print(f'\nTotal entries: {len(db)}')

    with open(OUTPUT, 'w', encoding='utf-8') as f:
        json.dump(db, f, ensure_ascii=False, indent=None, separators=(',', ':'))

    print(f'Written to {OUTPUT}')


if __name__ == '__main__':
    main()
