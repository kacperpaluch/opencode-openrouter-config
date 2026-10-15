# OpenCode Models

Mała lokalna aplikacja do wybierania modeli z OpenRoutera i zapisywania ich w configu OpenCode.
Przeglądasz katalog modeli, porównujesz providerów (ceny, precyzję, kontekst, dostępność),
wybierasz i klikasz „Dodaj do configu”. Aplikacja sama aktualizuje `opencode.jsonc`.

## Uruchomienie

Wymaga [Bun](https://bun.sh).

```sh
cd ~/Github/opencode-openrouter-config
bun install   # tylko za pierwszym razem
bun start
```

Strona otworzy się w przeglądarce pod `http://127.0.0.1:4747`. Jeśli serwer już działa,
`bun start` tylko otworzy stronę. Zatrzymanie: `Ctrl+C` w terminalu.

Serwer wyłącza się sam po 30 minutach bez żadnego zapytania. Jeśli zostawisz otwartą kartę dłużej,
strona pokaże komunikat, że serwer nie odpowiada. Wtedy uruchom aplikację ponownie.

### Aplikacja w Spotlight / Docku

```sh
./scripts/install-app.sh
```

Tworzy `~/Applications/OpenCode Models.app`. Od tej pory wystarczy **Cmd+Spacja → „OpenCode Models”**
(albo ikona w Docku): serwer startuje w tle bez terminala i otwiera się przeglądarka.
Logi serwera trafiają do `~/Library/Logs/opencode-openrouter-config.log`.

Aplikacja zapamiętuje ścieżkę do repo i do `bun`. Po przeniesieniu folderu uruchom skrypt ponownie.

Opcje:

| | |
|---|---|
| `PORT=5000 bun start` | inny port |
| `OPENCODE_CONFIG=/ścieżka/do/pliku.jsonc bun start` | inny plik configu (np. kopia do testów) |
| `bun server.ts --no-open` | bez otwierania przeglądarki |
| `IDLE_MINUTES=60 bun start` | inny czas automatycznego wyłączenia (`0` = nigdy) |

## Jak korzystać

### Lewa kolumna: Twój config

- **Role**:
  - **Główny model** (`model`): model, z którym rozmawiasz i który pisze kod.
  - **Model pomocniczy** (`small_model`): drobne zadania w tle, np. tytuły sesji. Warto ustawić coś taniego.
    Bez tego OpenCode sam wybiera model i może wziąć coś droższego.
- **Twoje modele**: modele OpenRoutera zapisane w configu. Kliknięcie otwiera edytor.
- **+ Dodaj model**: powrót do katalogu.

### Katalog

Lista wszystkich modeli OpenRoutera. Kliknij nagłówek kolumny, żeby posortować.
Domyślnie widać tylko modele z obsługą narzędzi (tool calling). Bez tego model nie edytuje plików w OpenCode.
Ceny w katalogu to ceny najtańszego providera.

### Edytor modelu

1. **Nazwa i rola**: nazwa widoczna w OpenCode (generuje się sama), ustawienie modelu jako głównego
   lub pomocniczego oraz **Licz koszt sesji** (opis niżej).
2. **Kto obsługuje zapytania**:
   - **Automatycznie**: OpenRouter sam wybiera providera (cena + dostępność).
   - **Wybrani providerzy**: klikasz wiersze w tabeli. Kolejność kliknięć to kolejność prób:
     pierwszy jest główny, kolejni zapasowi.
     Opcja „Gdy wybrani nie odpowiadają, użyj innego providera” pozwala OpenRouterowi przełączyć się
     na dowolnego innego providera przy awarii. Wyłączona daje pewność ceny i jakości, ale przy awarii dostaniesz błąd.
   - **Routery** (`openrouter/free`, `openrouter/auto` itp.) same dobierają model i providera,
     więc nie ma tu czego wybierać.
Jeśli provider zmienił cenę od ostatniego zapisu, edytor pokaże ostrzeżenie (np. „wejście $0.04 → $0.06”).
Wystarczy kliknąć **Zapisz zmiany**, żeby zaktualizować `cost`.

3. **Pasek na dole** pokazuje, co zostanie zapisane. Tam są przyciski **Dodaj do configu** / **Zapisz zmiany** i **Usuń z configu**.

### Kolumny tabeli providerów

| Kolumna | Znaczenie |
|---|---|
| Precyzja | Kwantyzacja wag. `bf16`/`fp8` to praktycznie pełna jakość. `fp4`/`nvfp4`/`int4` są tańsze i szybsze, ale model może działać trochę gorzej, co przy długiej pracy agenta ma znaczenie. `unknown`: provider nie podaje. |
| Wejście / Wyjście / 1M | Cena w USD za milion tokenów wysłanych do modelu / wygenerowanych przez model |
| Cache / 1M | Cena tokenów wejściowych odczytanych z cache. W długich sesjach to większość wejścia. |
| Kontekst | Ile tokenów model widzi naraz |
| Maks. odpowiedź | Najdłuższa odpowiedź w jednym kroku |
| Dostępność 24h | Uptime providera z ostatniej doby |

## Co trafia do configu

Przykład wpisu z przypiętym providerem:

```jsonc
"provider": {
  "openrouter": {
    "models": {
      "z-ai/glm-5.3-flash": {
        "name": "GLM 5.3 Flash — StreamLake",
        "limit": { "context": 1024000, "output": 128000 },
        "cost": { "input": 0.0435, "output": 0.14, "cache_read": 0.0087 },
        "options": {
          "provider": { "order": ["streamlake/fp8"], "allow_fallbacks": false }
        }
      }
    }
  }
},
"model": "openrouter/z-ai/glm-5.3-flash",
"small_model": "openrouter/z-ai/glm-5.3-flash"
```

- **`limit`**: kontekst i maksymalna odpowiedź. Przy kilku providerach brane jest minimum,
  żeby limit pasował do każdego z nich. Gdy OpenRouter nie podaje limitu odpowiedzi, wpisywane jest 32768.
- **`cost`**: ceny pierwszego providera w USD za 1M tokenów. Służą **tylko** do licznika kosztów w OpenCode
  i nie wpływają na rachunek, który i tak liczy OpenRouter. Bez tej sekcji OpenCode bierze ogólną cenę modelu
  z models.dev, która może się mocno różnić od ceny wybranego providera. Przy routerach ze zmienną ceną sekcja jest pomijana.
- **`options.provider`**: ustawienia routingu OpenRoutera. `order` to lista providerów (tagi z API),
  `allow_fallbacks` decyduje, czy wolno użyć innych. W trybie „Automatycznie” tej sekcji nie ma.

## Jak to działa

```
przeglądarka (index.html)  ⇄  server.ts (Bun, 127.0.0.1:4747)  ⇄  OpenRouter API (publiczne, bez klucza)
                                         ⇣
                         ~/.config/opencode/opencode.jsonc
```

- **`server.ts`**: mały serwer w Bun.
  - Pobiera dane z OpenRoutera (`/api/v1/models` i `/api/v1/models/{id}/endpoints`) i trzyma je w pamięci przez 5 minut.
    Żeby wymusić świeże dane, zrestartuj serwer.
  - Czyta i zapisuje config przez `jsonc-parser`. Zmienia tylko konkretne pola, więc komentarze,
    formatowanie i reszta configu (pluginy, inne ustawienia) zostają nietknięte.
  - Przed każdym zapisem robi kopię **`opencode.jsonc.bak`** (tylko ostatnią).
  - Nasłuchuje wyłącznie na `127.0.0.1` i odrzuca zapisy wysłane z innych stron.
- **`scripts/install-app.sh`**: buduje `OpenCode Models.app` przez `osacompile` (AppleScript uruchamiający serwer).
- **`index.html`**: cały interfejs, czysty HTML/CSS/JS bez frameworka i bez budowania.

Config wybierany jest w kolejności: zmienna `OPENCODE_CONFIG`, potem `~/.config/opencode/opencode.jsonc`,
potem `~/.config/opencode/opencode.json`.

## Przywracanie configu

Jeśli coś pójdzie nie tak, przywróć stan sprzed ostatniego zapisu:

```sh
cp ~/.config/opencode/opencode.jsonc.bak ~/.config/opencode/opencode.jsonc
```

## Ograniczenia

- Aplikacja zarządza tylko modelami providera `openrouter`. Inne wpisy w configu są widoczne
  (np. w rolach), ale ich nie edytuje.
- API OpenRoutera nie podaje latency ani throughput, więc tych kolumn nie ma.
- `cost` odpowiada pierwszemu providerowi. Jeśli zapytanie trafi do zapasowego, licznik w OpenCode będzie przybliżony.
