# Historia czatu

- `/undo` cofa ostatnią turę użytkownika wraz z odpowiedziami i wynikami narzędzi. Tekst cofniętego promptu trafia do edytora (natywne zachowanie `/tree`; obrazy pozostają w oryginalnej gałęzi).
- `/redo` wraca do dokładnego punktu sprzed `/undo` i odtwarza poprzedni tekst edytora. Można cofać/przywracać wiele tur. Nowa odpowiedź agenta, zewnętrzna nawigacja, zmiana sesji lub `/reload` kasują stos redo. Stare gałęzie nadal są dostępne przez `/tree`.
- `/retry` uruchamia kolejną turę tylko po Escape/przerwaniu albo odpowiedzi providera ze `stopReason: error` (także błędy konfiguracji/autoryzacji — najpierw należy usunąć ich przyczynę). Nie jest dostępne po prawidłowo zakończonej odpowiedzi ani samym błędzie narzędzia. Automatyczne retry musi najpierw się zakończyć.

Wszystkie komendy wymagają bezczynnego agenta i pustej kolejki. Nie przyjmują argumentów. Nawigacja nie wywołuje modelu ani podsumowania gałęzi, nie przywraca plików i nie cofa efektów narzędzi. Korzysta z natywnego `navigateTree`, które odbudowuje kontekst i zestaw narzędzi z wybranej gałęzi.

API rozszerzeń Pi 1.4 nie udostępnia bezpośredniego `continue()`: retry dodaje ukrytą wiadomość kontekstową z poleceniem kontynuacji. Zachowuje poprzednie wyniki narzędzi; nie wysyła ponownie pierwotnego promptu. Kontynuujący agent może oczywiście wykonywać narzędzia i zmieniać pliki. Nie ma gwarancji dokładnie jednokrotnego wykonania operacji przerwanej w połowie.

Testy: `node --test ~/.pi/agent/tests/chat-history.test.mjs`
