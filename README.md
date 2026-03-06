# Tracker tkanin – slow motion

Prosta aplikacja HTML (offline-first) do śledzenia statusu nagrań **tkanina → kolor → status**.

- Działa lokalnie (otwierasz `index.html`) oraz po hostingu na GitHub Pages / Firebase Hosting.
- Dane zapisują się w `localStorage` przeglądarki.
- Backup / Import działa przez plik JSON.

## Statusy
- ✕ Do nagrania
- ? Do poprawy
- ✓ Zrobione

## Jak zacząć
1. Otwórz `index.html`.
2. Dodaj kolekcje i tkaniny w **Ustawieniach**.
3. Kliknij tkaninę po lewej — szczegóły i kolory otworzą się po prawej.

## Backup / przenoszenie danych
- **Eksport JSON**: pełna kopia danych.
- **Import JSON**: przywraca dane w tej przeglądarce.

> W paczce nie ma żadnych firmowych nazw ani gotowych danych.


## Migracja danych ze starszych wersji
Jeśli masz dane zapisane w starszej wersji trackera na tym samym komputerze, aplikacja spróbuje je automatycznie wczytać.
