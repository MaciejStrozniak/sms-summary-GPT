// app.js

// Importowanie niezbędnych modułów
const { google } = require('googleapis');
// const { authenticate } = require('@google-cloud/local-auth'); // To nie będzie potrzebne w Cloud Run
const path = require('path'); // Nadal przydatne, choć mniej
const fs = require('fs').promises; // Będzie używane do odczytu credentials.json LOKALNIE (jednorazowo), ale nie w Cloud Run
require('dotenv').config(); // Ładuje zmienne środowiskowe z pliku .env
const { Storage } = require('@google-cloud/storage'); // Nowy import dla Google Cloud Storage
const express = require('express'); // Nowy import dla serwera HTTP (Cloud Run)

const app = express();
app.use(express.json()); // Do parsowania JSON z requestów HTTP

// Definicja stałych (ścieżki do plików, które będą używane tylko LOKALNIE do uzyskania refresh_token)
// W Cloud Run te pliki nie będą istnieć, a ich wartości będą zmiennymi środowiskowymi.
const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');
const TOKEN_PATH = path.join(process.cwd(), 'token.json'); // Plik, w którym będzie zapisywany refresh_token LOKALNIE
const SUMMARY_FILE_NAME = 'daily_summaries.json'; // Nazwa pliku JSON z podsumowaniami w Cloud Storage

// --- Zmienne środowiskowe dla Cloud Run ---
// Będą one ustawione w konfiguracji serwisu Cloud Run
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'urn:ietf:wg:oauth:2.0:oob'; // Domyślne dla aplikacji desktopowych
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const GCS_BUCKET_NAME = process.env.GCS_BUCKET_NAME; // Nazwa zasobnika Cloud Storage

// Inicjalizacja Google Cloud Storage
const storage = new Storage();

// --- Funkcje autoryzacji Google API (dostosowane do Cloud Run) ---

/**
 * Tworzy i zwraca obiekt OAuth2Client na podstawie zmiennych środowiskowych.
 * W środowisku Cloud Run nie będziemy używać plików localnych.
 * @returns {Object} Autoryzowany klient OAuth2.
 */
function getOAuth2ClientFromEnv() {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
    throw new Error('BŁĄD: Brak niezbędnych zmiennych środowiskowych Google Client ID, Client Secret lub Redirect URI.');
  }
  const oAuth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );

  // Jeśli dostępny jest refresh_token ze zmiennych środowiskowych, użyj go.
  // Jest to kluczowe dla automatycznej autoryzacji w Cloud Run.
  if (GOOGLE_REFRESH_TOKEN) {
    oAuth2Client.setCredentials({
      refresh_token: GOOGLE_REFRESH_TOKEN,
    });
    // Wymuszenie odświeżenia tokena dostępu, aby upewnić się, że jest aktualny.
    // getAccessToken() automatycznie użyje refresh_token do odświeżenia, jeśli access_token wygasł.
    oAuth2Client.getAccessToken().then(res => {
      oAuth2Client.credentials.access_token = res.token;
      console.log('Token dostępu odświeżony pomyślnie z refresh_token.');
    }).catch(err => {
      console.error('Błąd podczas odświeżania tokena dostępu z refresh_token:', err.message);
      // W środowisku produkcyjnym warto zaimplementować alert, jeśli refresh_token jest nieprawidłowy
    });
  } else {
    // W środowisku lokalnym to jest ok, bo autoryzacja dzieje się interaktywnie.
    // W Cloud Run ten przypadek powinien być błędem, chyba że aplikacja jest uruchamiana w trybie interaktywnym (co nie jest celem).
    console.warn('OSTRZEŻENIE: Brak GOOGLE_REFRESH_TOKEN w zmiennych środowiskowych. Aplikacja nie będzie mogła automatycznie autoryzować Google API w Cloud Run.');
  }

  return oAuth2Client;
}


/**
 * Funkcja autoryzacji dla Cloud Run. Zawsze używa zmiennych środowiskowych.
 * W środowisku lokalnym, nadal możesz użyć poprzedniej logiki z plikami token.json
 * do JEDNORAZOWEGO uzyskania refresh_token.
 * @returns {Promise<Object>} Autoryzowany klient OAuth2.
 */
async function authorize() {
    // Dla Cloud Run, zawsze próbujemy autoryzacji ze zmiennych środowiskowych.
    try {
        const client = getOAuth2ClientFromEnv();
        // W przypadku Cloud Run, sama inicjalizacja z refresh_token jest traktowana jako autoryzacja.
        // Ewentualne błędy odświeżania tokena będą logowane w getOAuth2ClientFromEnv.
        return client;
    } catch (err) {
        console.error('Krytyczny błąd podczas inicjalizacji autoryzacji dla Cloud Run:', err.message);
        throw err;
    }
}


// --- Narzędzia do obsługi Google Sheets (Arkuszy Google) ---

/**
 * Pobiera dane z określonego zakresu w Arkuszu Google.
 * Traktuje to jako ogólne narzędzie do odczytu danych z arkusza.
 * @param {Object} auth - Obiekt autoryzacji Google (uzyskany z funkcji authorize()).
 * @param {string} spreadsheetId - ID Arkusza Google.
 * @param {string} range - Zakres komórek do pobrania (np. 'NazwaZakladki!A:Z').
 * @returns {Promise<Array<Array<string>>>} Tablica wierszy z danymi. Każdy wiersz to tablica komórek.
 */
async function getSheetData(auth, spreadsheetId, range) {
  const sheets = google.sheets({ version: 'v4', auth }); // Inicjalizacja API Arkuszy Google
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId, // ID arkusza
      range,         // Zakres danych do pobrania
    });
    const rows = response.data.values; // Dane są w response.data.values
    if (!rows || rows.length === 0) {
      console.log('Nie znaleziono danych w arkuszu dla podanego zakresu.');
      return []; // Zwracamy pustą tablicę, jeśli brak danych
    }
    return rows;
  } catch (err) {
    console.error('Błąd podczas pobierania danych z Arkusza Google:', err.message);
    throw err; // Przekazujemy błąd dalej
  }
}

/**
 * Zwraca bieżącą datę w formacie YYYY-MM-DD.
 * Jest to kluczowe dla filtrowania danych dziennych.
 * Jeśli daty w Twoim arkuszu są w innym formacie (np. DD.MM.YYYY, M/D/YYYY),
 * BĘDZIESZ MUSIAŁ DOSTOSOWAĆ TĘ FUNKCJĘ I/LUB LOGIKĘ W filterDailyData().
 * @returns {string} Bieżąca data sformatowana jako YYYY-MM-DD.
 */
function getCurrentFormattedDate() {
  const today = new Date();
  const year = today.getFullYear();
  // Miesiące są od 0 (styczeń) do 11 (grudzień), więc dodajemy 1
  const month = (today.getMonth() + 1).toString().padStart(2, '0'); // Dodaje '0' z przodu, jeśli < 10
  const day = today.getDate().toString().padStart(2, '0');         // Dodaje '0' z przodu, jeśli < 10
  return `${year}-${month}-${day}`;
}

/**
 * Filtruje wiersze pobrane z arkusza, zwracając tylko te, które pasują do bieżącej daty.
 * Zakłada, że data do porównania znajduje się w PIERWSZEJ KOLUMNIE (indeks 0).
 * Funkcja próbuje sparsować datę z komórki i porównać ją z dzisiejszą datą.
 * @param {Array<Array<string>>} rows - Wszystkie wiersze pobrane z arkusza (włączając nagłówki).
 * @returns {Array<Array<string>>} Tablica wierszy pasujących do bieżącej daty, z zachowanymi nagłówkami.
 */
function filterDailyData(rows) {
  const todayFormatted = getCurrentFormattedDate();
  console.log(`Filtruję dane z arkusza dla daty: ${todayFormatted}`);

  // Zakładamy, że pierwszy wiersz to nagłówki kolumn.
  const headers = rows.length > 0 ? rows[0] : [];
  // Pozostałe wiersze to dane (pomijamy nagłówki do filtrowania).
  const dataRows = rows.length > 1 ? rows.slice(1) : []; 

  const dailyData = dataRows.filter(row => {
    // Sprawdzamy, czy wiersz nie jest pusty i czy pierwsza komórka (kolumna z datą) istnieje
    if (row && row.length > 0 && row[0]) {
      try {
        // Próbujemy stworzyć obiekt Date z wartości komórki.
        // Ważne: JavaScriptowy Date.parse() jest elastyczny, ale najlepiej, aby format był spójny.
        const cellDate = new Date(row[0]);
        // Sprawdzamy, czy data jest prawidłowa (czy Date nie zwróciło 'Invalid Date')
        if (isNaN(cellDate.getTime())) {
          return false; // Nieprawidłowa data w komórce, ignorujemy wiersz
        }

        const cellYear = cellDate.getFullYear();
        const cellMonth = (cellDate.getMonth() + 1).toString().padStart(2, '0');
        const cellDay = cellDate.getDate().toString().padStart(2, '0');
        const cellFormattedDate = `${cellYear}-${cellMonth}-${cellDay}`;

        // Porównujemy sformatowane daty
        return cellFormattedDate === todayFormatted;
      } catch (e) {
        // Jeśli wystąpi błąd podczas parsowania daty, oznacza to, że format jest nieznany/niepoprawny
        // console.warn(`Ostrzeżenie: Nie udało się sparsować daty "${row[0]}". Błąd: ${e.message}`);
        return false; 
      }
    }
    return false; // Ignoruj puste wiersze lub wiersze bez wartości w pierwszej kolumnie
  });

  // Zwracamy nagłówki (jeśli istnieją) plus sfiltrowane wiersze dzienne
  return headers.length > 0 ? [headers, ...dailyData] : dailyData;
}

/**
 * Mapuje zadania do odpowiednich osób na podstawie danych z Arkusza Google,
 * dodając datę i nazwę dnia tygodnia.
 * Oczekuje formatu danych: [[Nagłówek1, Osoba1, Osoba2], [Data, Zadanie1, Zadanie2]]
 * @param {Array<Array<string>>} dailyData - Sfiltrowane dane dla bieżącego dnia (wraz z nagłówkami).
 * @returns {Object} Obiekt zawierający datę, nazwę dnia tygodnia i zadania przyporządkowane do osób.
 */
function mapTasksToPeople(dailyData) {
  if (!dailyData || dailyData.length < 2) {
    console.warn('Brak wystarczających danych do mapowania zadań na osoby. Oczekiwano nagłówków i co najmniej jednego wiersza danych.');
    return { date: null, dayOfWeek: null, tasksByPerson: {} };
  }

  const headers = dailyData[0]; // Pierwszy wiersz to nagłówki (np. ['', 'Janek', 'Dzbanek'])
  const taskRow = dailyData[1];  // Drugi wiersz to zadania dla bieżącego dnia (np. ['2025-06-25', 'Robię placki', 'Śpię'])

  const personTasks = {};
  let date = null;
  let dayOfWeek = null;

  // Pobierz datę z pierwszej komórki wiersza zadań i sformatuj ją
  if (taskRow && taskRow.length > 0 && taskRow[0]) {
    try {
      const taskDate = new Date(taskRow[0]);
      if (!isNaN(taskDate.getTime())) {
        date = taskDate.toISOString().split('T')[0]; // Format YYYY-MM-DD
        dayOfWeek = taskDate.toLocaleDateString('pl-PL', { weekday: 'long' }); // Nazwa dnia tygodnia po polsku
      }
    } catch (e) {
      console.warn(`Nie udało się sparsować daty z wiersza zadań: ${taskRow[0]}. Błąd: ${e.message}`);
    }
  }

  // Pętla zaczyna się od indeksu 1, aby pominąć pustą komórkę/datę w nagłówkach i wierszu zadań
  for (let i = 1; i < headers.length; i++) {
    const personName = headers[i];
    const task = taskRow[i];

    if (personName && task) { // Upewnij się, że zarówno nazwa osoby, jak i zadanie istnieją
      personTasks[personName] = task;
    }
  }

  return {
    date: date,
    dayOfWeek: dayOfWeek,
    tasksByPerson: personTasks
  };
}

// --- Narzędzia do anonimizacji i de-anonimizacji danych personalnych ---

/**
 * Anonimizuje dane personalne w tekście i w kluczach obiektu zadań.
 * Zastępuje imiona placeholderami i tworzy mapowanie.
 * @param {Object} data - Obiekt danych zawierający tasksByPerson.
 * @returns {Object} Obiekt zawierający anonimowe dane i mapowanie.
 */
function anonymizePersonalData(data) {
  const originalToPlaceholderMap = {}; // Mapowanie: oryginalne imię -> placeholder
  const placeholderToOriginalMap = {}; // Mapowanie: placeholder -> oryginalne imię
  let employeeCounter = 0; // Licznik dla placeholderów pracowników

  const anonymizedTasksByPerson = {};
  
  // 1. Anonimizacja kluczy (imion pracowników) w tasksByPerson
  for (const originalName of Object.keys(data.tasksByPerson)) {
    let placeholder = originalToPlaceholderMap[originalName];
    if (!placeholder) {
      employeeCounter++;
      placeholder = `pracownik_${employeeCounter}`;
      originalToPlaceholderMap[originalName] = placeholder;
      placeholderToOriginalMap[placeholder] = originalName;
    }
    anonymizedTasksByPerson[placeholder] = data.tasksByPerson[originalName];
  }

  // 2. Anonimizacja imion pracowników W OPISACH ZADAŃ
  // Tworzymy kopię zadań do anonimizacji
  const anonymizedTasksContent = {};
  for (const placeholder in anonymizedTasksByPerson) {
      let taskDescription = anonymizedTasksByPerson[placeholder];
      
      // Zastąp wszystkie wystąpienia oryginalnych imion ich placeholderami w opisach zadań
      for (const originalName in originalToPlaceholderMap) {
          const namePlaceholder = originalToPlaceholderMap[originalName];
          // Używamy wyrażenia regularnego z flagą 'g' (global) dla wszystkich wystąpień
          // i 'i' (case-insensitive) dla braku wrażliwości na wielkość liter
          const regex = new RegExp(`\\b${originalName}\\b`, 'gi'); // \b to granica słowa
          taskDescription = taskDescription.replace(regex, namePlaceholder);
      }
      anonymizedTasksContent[placeholder] = taskDescription;
  }

  // Rekonstruujemy anonimowy obiekt danych
  const anonymizedData = {
    date: data.date,
    dayOfWeek: data.dayOfWeek,
    tasksByPerson: anonymizedTasksContent // Używamy treści po anonimizacji imion
  };

  return {
    anonymizedData,
    personalDataMap: placeholderToOriginalMap // Zwracamy mapowanie placeholder -> oryginalne
  };
}


/**
 * De-anonimizuje tekst, zastępując placeholdery z powrotem oryginalnymi danymi.
 * Funkcja została ulepszona, aby radzić sobie z różnymi formatami placeholderów
 * generowanymi przez LLM (np. "Pracownik 1" zamiast "pracownik_1").
 * @param {string} anonymizedText - Tekst z placeholderami (np. podsumowanie z LLM).
 * @param {Object} personalDataMap - Mapowanie { placeholder: oryginalneDane }.
 * @returns {string} Tekst z przywróconymi oryginalnymi danymi.
 */
function deanonymizeSummary(anonymizedText, personalDataMap) {
  let deAnonymizedText = anonymizedText;
  // Przechodzimy przez mapowanie placeholder -> oryginalne dane
  for (const placeholder in personalDataMap) {
    const originalData = personalDataMap[placeholder];
    
    // Rozbij placeholder (np. "pracownik_1" na "pracownik" i "1")
    const parts = placeholder.split('_');
    if (parts.length === 2) {
      const baseName = parts[0]; // np. "pracownik"
      const number = parts[1];   // np. "1"

      // Tworzymy bardziej elastyczne wyrażenie regularne, które pasuje do:
      // - początkowej litery (mała/duża) np. p/P
      // - nazwy bazowej (reszta słowa) np. racownik
      // - separatora (spacja lub podkreślenie)
      // - numeru
      const flexibleRegex = new RegExp(
        `\\b[${baseName[0].toLowerCase()}${baseName[0].toUpperCase()}]` +
        `${baseName.substring(1)}[_ ]${number}\\b`, // [_ ] match underscore or space
        'gi' // global i case-insensitive
      );
      
      deAnonymizedText = deAnonymizedText.replace(flexibleRegex, originalData);
    } else {
      // Jeśli placeholder nie jest w oczekiwanym formacie, używamy domyślnego regex (mniej elastycznego)
      const regex = new RegExp(`\\b${placeholder}\\b`, 'gi');
      deAnonymizedText = deAnonymizedText.replace(regex, originalData);
    }
  }
  return deAnonymizedText;
}

// --- Narzędzia do komunikacji z LLM (OpenAI GPT API) ---

/**
 * Generuje podsumowanie na podstawie anonimowych danych za pomocą OpenAI GPT API.
 * @param {Object} anonymizedData - Anonimowe dane do podsumowania.
 * @returns {Promise<string>} Podsumowanie wygenerowane przez LLM.
 */
async function generateSummaryWithLLM(anonymizedData) {
  const apiKey = process.env.OPENAI_API_KEY; // Pobieramy klucz API z pliku .env

  if (!apiKey) {
    throw new Error('BŁĄD: Klucz OPENAI_API_KEY nie został ustawiony w pliku .env!');
  }

  const apiUrl = 'https://api.openai.com/v1/chat/completions'; // Endpoint API OpenAI

  // Budujemy prompt dla LLM. Ważne, aby był zwięzły i jasno określał zadanie.
  const prompt = `
  Stwórz bardzo krótkie (maks. 160 znaków), zwięzłe podsumowanie dziennych zadań. Podsumowanie ma być w języku polskim i nadawać się do wysłania SMS-em. 
  Skup się na przypisaniu zadań konkretnym osobom.
  Podaj dzień tygodnia, w którym mają być realizowana zadania.

  WAŻNE
  Nie zmieniaj składni nazw pracownik_1, pracownik_2. W Twojej odpowiedzi zawsze trzymaj podanej formy.

  Oto dane:
  Dzień tygodnia: ${anonymizedData.dayOfWeek}
  Data: ${anonymizedData.date}
  Zadania: ${JSON.stringify(anonymizedData.tasksByPerson, null, 2)}

  Podsumowanie:`;

  const payload = {
    model: "gpt-3.5-turbo", // Możesz zmienić na "gpt-4" lub inny dostępny model
    messages: [
      { role: "system", content: "Jesteś pomocnym asystentem, który generuje zwięzłe podsumowania zadań." },
      { role: "user", content: prompt }
    ],
    temperature: 0.7, // Kontroluje kreatywność (niższa wartość = bardziej przewidywalne wyniki)
    max_tokens: 100,  // Ograniczamy liczbę tokenów, aby podsumowanie było krótkie
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
  };

  console.log('Wysyłam zapytanie do OpenAI GPT API...');
  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}` // Autoryzacja za pomocą Bearer tokena
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Błąd HTTP ${response.status}: ${errorText}`);
    }

    const result = await response.json();

    if (result.choices && result.choices.length > 0 &&
        result.choices[0].message && result.choices[0].message.content) {
      return result.choices[0].message.content;
    } else {
      console.warn('Nieoczekiwana struktura odpowiedzi z OpenAI GPT API lub brak treści.', result);
      return 'Brak możliwości wygenerowania podsumowania.';
    }
  } catch (error) {
    console.error('Błąd komunikacji z OpenAI GPT API:', error);
    throw new Error(`Nie udało się wygenerować podsumowania: ${error.message}`);
  }
}

// --- Narzędzia do zapisu lokalnego (JSON) ---

/**
 * Zapisuje lub aktualizuje plik JSON z codziennymi podsumowaniami.
 * Jeśli plik istnieje, dodaje nowy wpis. Jeśli nie, tworzy nowy plik.
 * Każde podsumowanie jest obiektem zawierającym datę, dzień tygodnia i treść podsumowania.
 * @param {Object} summaryData - Obiekt z danymi do zapisania (np. { date, dayOfWeek, summary: finalSummary }).
 * @param {string} filePath - Ścieżka do pliku JSON.
 */
async function saveSummaryToJsonFile(summaryData, filePath) {
  let existingSummaries = [];
  try {
    const fileContent = await fs.readFile(filePath, 'utf8');
    existingSummaries = JSON.parse(fileContent);
    if (!Array.isArray(existingSummaries)) {
      console.warn('Plik JSON nie zawiera tablicy. Zostanie utworzona nowa tablica.');
      existingSummaries = [];
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log(`Plik ${filePath} nie istnieje. Tworzę nowy plik.`);
    } else {
      console.error(`Błąd podczas odczytu lub parsowania pliku ${filePath}:`, err.message);
      // Nadal kontynuujemy z pustą tablicą, aby uniknąć zatrzymania aplikacji
      existingSummaries = [];
    }
  }

  // Dodaj nowe podsumowanie do tablicy
  existingSummaries.push(summaryData);

  // Zapisz zaktualizowaną tablicę z powrotem do pliku
  try {
    await fs.writeFile(filePath, JSON.stringify(existingSummaries, null, 2), 'utf8');
    console.log(`Podsumowanie pomyślnie zapisane do pliku: ${filePath}`);
  } catch (err) {
    console.error(`Błąd podczas zapisu do pliku ${filePath}:`, err.message);
    throw err;
  }
}

// --- Narzędzia do wysyłki e-maili (Gmail) ---

/**
 * Wysyła wiadomość e-mail za pośrednictwem Gmail API.
 * @param {Object} auth - Obiekt autoryzacji Google (OAuth2Client).
 * @param {string} recipientEmail - Adres e-mail odbiorcy.
 * @param {string} subject - Temat wiadomości.
 * @param {string} body - Treść wiadomości (zwykły tekst).
 */
async function sendEmail(auth, recipientEmail, subject, body) {
  const gmail = google.gmail({ version: 'v1', auth });

  // Tworzenie treści wiadomości w formacie RFC 2822 (standard e-mail)
  const emailContent = [
    `To: ${recipientEmail}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'MIME-Version: 1.0',
    `Subject: =?utf-8?B?${Buffer.from(subject).toString('base64')}?=`, // Kodowanie tematu UTF-8
    '', // Pusta linia oddzielająca nagłówki od treści
    body,
  ].join('\n');

  // Kodowanie wiadomości do base64url (wymagane przez Gmail API)
  const encodedMessage = Buffer.from(emailContent).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  try {
    const response = await gmail.users.messages.send({
      userId: 'me', // 'me' odnosi się do uwierzytelnionego użytkownika
      requestBody: {
        raw: encodedMessage,
      },
    });
    console.log(`E-mail pomyślnie wysłany do ${recipientEmail}. ID wiadomości: ${response.data.id}`);
    return response.data;
  } catch (err) {
    console.error(`Błąd podczas wysyłania e-maila do ${recipientEmail}:`, err.message);
    throw err;
  }
}

// --- Główna funkcja aplikacji (punkt startowy) ---

async function main() {
  try {
    // Krok 1: Autoryzacja do Google API
    const auth = await authorize();
    console.log('Autoryzacja Google API pomyślna!');

    // --- Konfiguracja Arkusza Google pobrana z .env ---
    const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
    const SHEET_NAME = process.env.SHEET_NAME;
    const RANGE = `${SHEET_NAME}!A:Z`; // Zakres danych do pobrania (całe kolumny od A do Z z wybranej zakładki)
    const RECIPIENT_EMAIL = process.env.RECIPIENT_EMAIL; // Adres e-mail odbiorcy podsumowania

    if (!SPREADSHEET_ID || !SHEET_NAME) {
      console.error('BŁĄD: Proszę uzupełnić SPREADSHEET_ID i SHEET_NAME w pliku .env przed uruchomieniem!');
      console.error('Przykład zawartości pliku .env:');
      console.error('SPREADSHEET_ID=twoje_id_arkusza');
      console.error('SHEET_NAME=NazwaZakladki');
      console.error('RECIPIENT_EMAIL=twoj.email@example.com');
      return; // Zakończ działanie aplikacji
    }

    if (!RECIPIENT_EMAIL) {
      console.error('BŁĄD: Proszę uzupełnić RECIPIENT_EMAIL w pliku .env przed uruchomieniem!');
      console.error('Przykład zawartości pliku .env:');
      console.error('RECIPIENT_EMAIL=twoj.email@example.com');
      return; // Zakończ działanie aplikacji
    }

    console.log(`Pobieram wszystkie dane z arkusza: ${SPREADSHEET_ID}, zakres: ${RANGE}`);
    const allRows = await getSheetData(auth, SPREADSHEET_ID, RANGE);

    if (allRows.length > 0) {
      console.log(`Pobrano ${allRows.length} wierszy danych z arkusza.`);
      // console.log('Przykładowy pierwszy wiersz pobranych danych:', allRows[0]); // Odkomentuj do debugowania

      // Krok 2: Filtrowanie danych dla bieżącego dnia
      const dailyData = filterDailyData(allRows);

      if (dailyData.length > 1) { // Sprawdzamy > 1, bo dailyData zawiera nagłówki + dane
        console.log(`Znaleziono ${dailyData.length - 1} wierszy danych zadań dla dzisiaj.`);
        // console.log('Dane dzienne (surowe):', dailyData); // Odkomentuj do debugowania

        // Krok 3: Mapowanie zadań do osób
        const mappedTasks = mapTasksToPeople(dailyData);
        console.log('Zadania przyporządkowane do osób (wraz z datą i dniem tygodnia):');
        console.log(mappedTasks); // Wyświetl nową, ustrukturyzowaną formę danych

        // Krok 4: Anonimizacja danych personalnych
        console.log('\n--- Rozpoczynam anonimizację danych ---');
        const { anonymizedData, personalDataMap } = anonymizePersonalData(mappedTasks);
        console.log('Dane po anonimizacji (do przekazania do LLM):');
        console.log(anonymizedData);
        console.log('Mapowanie danych personalnych (placeholder -> oryginał):', personalDataMap);

        // Krok 5: Generowanie podsumowania za pomocą LLM (OpenAI GPT API)
        console.log('\n--- Generowanie podsumowania za pomocą OpenAI GPT API ---');
        const anonymizedSummaryFromLLM = await generateSummaryWithLLM(anonymizedData);
        console.log('Podsumowanie z LLM (anonimowe):');
        console.log(anonymizedSummaryFromLLM);


        // Krok 6: De-anonimizacja podsumowania z LLM
        console.log('\n--- Rozpoczynam de-anonimizację podsumowania ---');
        const finalSummary = deanonymizeSummary(anonymizedSummaryFromLLM, personalDataMap);
        console.log('Ostateczne podsumowanie (po de-anonimizacji):');
        console.log(finalSummary);

        // Krok 7: Zapis podsumowania do pliku JSON
        console.log('\n--- Zapisuję podsumowanie do pliku JSON ---');
        const summaryEntry = {
            date: mappedTasks.date,
            dayOfWeek: mappedTasks.dayOfWeek,
            summary: finalSummary
        };
        await saveSummaryToJsonFile(summaryEntry, SUMMARY_FILE_PATH);

        // Krok 8: Wysyłka podsumowania na adres e-mail
        console.log('\n--- Wysyłam podsumowanie na adres e-mail ---');
        const emailSubject = `Dzienne podsumowanie zadań na ${mappedTasks.dayOfWeek}, ${mappedTasks.date}`;
        await sendEmail(auth, RECIPIENT_EMAIL, emailSubject, finalSummary);

      } else {
        console.log('Brak danych zadań dla bieżącego dnia w arkuszu.');
      }
    } else {
      console.log('Arkusz jest pusty lub nie zawiera danych do przetworzenia.');
    }

  } catch (err) {
    console.error('Wystąpił krytyczny błąd w aplikacji:', err.message);
    console.error('Szczegóły błędu:', err); // Pełny obiekt błędu do szczegółowego debugowania
    console.error('Upewnij się, że masz poprawny plik credentials.json i token.json (spróbuj go usunąć i ponownie uruchomić, jeśli problem się powtarza).');
    console.error('Sprawdź też, czy ID Arkusza, nazwa zakładki i adres e-mail odbiorcy są poprawnie ustawione w .env oraz czy masz dostęp do internetu.');
    console.error('Jeśli używasz LLM, upewnij się, że klucz OPENAI_API_KEY jest poprawny i masz dostęp do API.');
  }
}

// Uruchomienie głównej funkcji aplikacji
main();