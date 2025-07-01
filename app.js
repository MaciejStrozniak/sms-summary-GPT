// app.js

// Importowanie niezbędnych modułów
const { google } = require('googleapis');
// const { authenticate } = require('@google-cloud/local-auth'); // To nie będzie potrzebne w Cloud Run
const path = require('path'); 
const fs = require('fs').promises; // Będzie używane tylko do jednorazowego lokalnego odczytu credentials.json dla refresh_token
require('dotenv').config(); // Ładuje zmienne środowiskowe z pliku .env
const { Storage } = require('@google-cloud/storage'); // Nowy import dla Google Cloud Storage
const express = require('express'); // Nowy import dla serwera HTTP (Cloud Run)

const app = express();
app.use(express.json()); // Do parsowania JSON z requestów HTTP

// --- Definicja stałych (ścieżki do plików LOKALNYCH) ---
// Te ścieżki są istotne TYLKO dla lokalnego wygenerowania refresh_token.
// W Cloud Run te pliki nie będą używane.
const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');
const TOKEN_PATH = path.join(process.cwd(), 'token.json'); // Plik, w którym lokalnie zapisujemy refresh_token

// --- Definicja stałych dla Cloud Storage ---
// Nazwa pliku w zasobniku GCS
const SUMMARY_FILE_NAME = 'daily_summaries.json'; 

// --- Zmienne środowiskowe dla Cloud Run ---
// Te zmienne MUSZĄ BYĆ ustawione w konfiguracji serwisu Cloud Run.
// Będą one używane zamiast lokalnych plików credentials.json i token.json.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
// URI przekierowania musi być taki sam jak skonfigurowany w Google Cloud Console dla "aplikacji komputerowej"
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'urn:ietf:wg:oauth:2.0:oob'; 
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN; // Kluczowy token do stałej autoryzacji w chmurze

// --- Inicjalizacja Google Cloud Storage ---
const storage = new Storage();
// Upewnij się, że GCS_BUCKET_NAME jest ustawione w zmiennych środowiskowych Cloud Run
// Ta linia zostanie wykonana tylko jeśli process.env.GCS_BUCKET_NAME jest zdefiniowane
// W przeciwnym razie, błąd zostanie wychwycony w runDailyTasks
let bucket; 
if (process.env.GCS_BUCKET_NAME) {
  bucket = storage.bucket(process.env.GCS_BUCKET_NAME);
}


// --- Funkcje autoryzacji Google API (dostosowane do Cloud Run) ---

/**
 * Tworzy i zwraca obiekt OAuth2Client na podstawie zmiennych środowiskowych.
 * Ta funkcja jest kluczowa dla działania aplikacji w Cloud Run, gdzie nie ma dostępu do plików lokalnych
 * credentials.json i token.json.
 * @returns {Object} Autoryzowany klient OAuth2.
 */
function getOAuth2ClientFromEnv() {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
    throw new Error('BŁĄD: Brak niezbędnych zmiennych środowiskowych (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI) do konfiguracji OAuth2Client.');
  }

  const oAuth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );

  // Sprawdzamy, czy jest dostępny GOOGLE_REFRESH_TOKEN.
  // Jest to absolutnie niezbędne do automatycznej, bezobsługowej autoryzacji w Cloud Run.
  if (GOOGLE_REFRESH_TOKEN) {
    oAuth2Client.setCredentials({
      refresh_token: GOOGLE_REFRESH_TOKEN,
    });
    // Próba odświeżenia tokena dostępu, aby upewnić się, że jest aktualny.
    // getAccessToken() automatycznie użyje refresh_token do odświeżenia, jeśli access_token wygasł.
    oAuth2Client.getAccessToken().then(res => {
      // res.token zawiera nowy access_token. Ustawiamy go na kliencie.
      oAuth2Client.credentials.access_token = res.token;
      console.log('Token dostępu odświeżony pomyślnie z refresh_token.');
    }).catch(err => {
      console.error('Błąd podczas odświeżania tokena dostępu z refresh_token w Cloud Run. Upewnij się, że token jest nadal ważny i ma odpowiednie zakresy. Konieczna ręczna regeneracja refresh_token, jeśli problem się powtarza:', err.message);
      // W środowisku produkcyjnym można rozważyć wysłanie alertu do administratora
    });
  } else {
    // Ten przypadek wskazuje na błąd konfiguracji w Cloud Run.
    throw new Error('BŁĄD: GOOGLE_REFRESH_TOKEN nie został ustawiony w zmiennych środowiskowych Cloud Run. Automatyczna autoryzacja Google API jest niemożliwa.');
  }

  return oAuth2Client;
}


/**
 * Funkcja autoryzacji dla środowiska Cloud Run.
 * Zawsze próbuje autoryzować się za pomocą zmiennych środowiskowych.
 * W środowisku lokalnym, nadal będziesz używać poprzedniej logiki z plikami token.json
 * do JEDNORAZOWEGO uzyskania refresh_token, który następnie umieścisz w zmiennych środowiskowych Cloud Run.
 * @returns {Promise<Object>} Autoryzowany klient OAuth2.
 */
async function authorize() {
    // W Cloud Run zawsze używamy konfiguracji ze zmiennych środowiskowych
    // i nie ma interaktywnej autoryzacji przez przeglądarkę.
    try {
        const client = getOAuth2ClientFromEnv();
        console.log('Autoryzacja Google API dla Cloud Run zainicjowana ze zmiennych środowiskowych.');
        return client;
    } catch (err) {
        console.error('Krytyczny błąd podczas inicjalizacji autoryzacji dla Cloud Run:', err.message);
        throw err;
    }
}


// --- Narzędzia do obsługi Google Sheets (Arkuszy Google) ---
// (BEZ ZMIAN W STOSUNUNKU DO POPRZEDNIEJ WERSJI)

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
// (BEZ ZMIAN W STOSUNKU DO POPRZEDNIEJ WERSJI)

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
// (BEZ ZMIAN W STOSUNKU DO POPRZEDNIEJ WERSJI)

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

// --- Narzędzia do zapisu podsumowania (dostosowane do Google Cloud Storage) ---

/**
 * Pobiera istniejące podsumowania z Google Cloud Storage.
 * @param {string} bucketName - Nazwa zasobnika GCS.
 * @param {string} fileName - Nazwa pliku JSON w zasobniku.
 * @returns {Promise<Array<Object>>} Tablica istniejących podsumowań lub pusta tablica.
 */
async function loadSummariesFromGCS(bucketName, fileName) {
  const file = storage.bucket(bucketName).file(fileName);
  try {
    const [exists] = await file.exists();
    if (exists) {
      const [content] = await file.download();
      const parsedContent = JSON.parse(content.toString('utf8'));
      if (Array.isArray(parsedContent)) {
        console.log(`Pomyślnie załadowano istniejące podsumowania z GCS: gs://${bucketName}/${fileName}`);
        return parsedContent;
      } else {
        console.warn(`Plik GCS ${fileName} nie zawiera tablicy. Zostanie utworzona nowa tablica.`);
        return [];
      }
    } else {
      console.log(`Plik GCS ${fileName} nie istnieje. Tworzę nową tablicę podsumowań.`);
      return [];
    }
  } catch (err) {
    console.error(`Błąd podczas odczytu lub parsowania pliku z GCS: gs://${bucketName}/${fileName}. Błąd: ${err.message}`);
    // Nadal kontynuujemy z pustą tablicą, aby uniknąć zatrzymania aplikacji
    return [];
  }
}

/**
 * Zapisuje (aktualizuje) plik JSON z codziennymi podsumowaniami w Google Cloud Storage.
 * Nowe podsumowanie jest dodawane do istniejącej tablicy.
 * @param {Object} summaryData - Obiekt z danymi do zapisania (np. { date, dayOfWeek, summary: finalSummary }).
 */
async function saveSummaryToGCS(summaryData) {
  if (!process.env.GCS_BUCKET_NAME) { // Używamy process.env.GCS_BUCKET_NAME
    throw new Error('BŁĄD: Nazwa zasobnika Cloud Storage (GCS_BUCKET_NAME) nie została ustawiona w zmiennych środowiskowych!');
  }

  // Używamy zmiennej 'bucket' zainicjalizowanej globalnie
  const file = bucket.file(SUMMARY_FILE_NAME); 

  const existingSummaries = await loadSummariesFromGCS(process.env.GCS_BUCKET_NAME, SUMMARY_FILE_NAME);
  existingSummaries.push(summaryData);

  try {
    await file.save(JSON.stringify(existingSummaries, null, 2), {
      contentType: 'application/json'
    });
    console.log(`Podsumowanie pomyślnie zapisane/aktualizowane w GCS: gs://${process.env.GCS_BUCKET_NAME}/${SUMMARY_FILE_NAME}`);
  } catch (err) {
    console.error(`Błąd podczas zapisu podsumowania do GCS: ${err.message}`);
    throw err;
  }
}


// --- Narzędzia do wysyłki e-maili (Gmail) ---
// (BEZ ZMIAN W STOSUNKU DO POPRZEDNIEJ WERSJI)

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


// --- Główna logika biznesowa aplikacji ---
// Funkcja `runDailyTasks` zawiera cały proces od pobrania danych po wysłanie maila.
async function runDailyTasks() {
  let auth;
  try {
    // Krok 1: Autoryzacja do Google API
    auth = await authorize(); // Używamy zmiennych środowiskowych do autoryzacji
    console.log('Autoryzacja Google API pomyślna!');

    // --- Konfiguracja Arkusza Google pobrana z .env / zmiennych środowiskowych ---
    const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
    const SHEET_NAME = process.env.SHEET_NAME;
    const RANGE = `${SHEET_NAME}!A:Z`; // Zakres danych do pobrania (całe kolumny od A do Z z wybranej zakładki)
    const RECIPIENT_EMAIL = process.env.RECIPIENT_EMAIL; // Adres e-mail odbiorcy podsumowania
    const GCS_BUCKET_NAME = process.env.GCS_BUCKET_NAME; // Nazwa zasobnika GCS

    // Sprawdzanie, czy wszystkie niezbędne zmienne środowiskowe są ustawione
    if (!SPREADSHEET_ID || !SHEET_NAME || !RECIPIENT_EMAIL || !GCS_BUCKET_NAME || !process.env.OPENAI_API_KEY || !GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI || !GOOGLE_REFRESH_TOKEN) {
      console.error('BŁĄD: Brakuje jednej lub więcej zmiennych środowiskowych (SPREADSHEET_ID, SHEET_NAME, RECIPIENT_EMAIL, GCS_BUCKET_NAME, OPENAI_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI, GOOGLE_REFRESH_TOKEN). Upewnij się, że są ustawione w konfiguracji Cloud Run.');
      // Rzucamy błąd, aby Cloud Run oznaczył to jako nieudane wykonanie
      throw new Error('Brak niezbędnych zmiennych środowiskowych do uruchomienia aplikacji.');
    }


    console.log(`Pobieram wszystkie dane z arkusza: ${SPREADSHEET_ID}, zakres: ${RANGE}`);
    const allRows = await getSheetData(auth, SPREADSHEET_ID, RANGE);

    if (allRows.length > 0) {
      console.log(`Pobrano ${allRows.length} wierszy danych z arkusza.`);

      // Krok 2: Filtrowanie danych dla bieżącego dnia
      const dailyData = filterDailyData(allRows);

      if (dailyData.length > 1) { // Sprawdzamy > 1, bo dailyData zawiera nagłówki + dane
        console.log(`Znaleziono ${dailyData.length - 1} wierszy danych zadań dla dzisiaj.`);

        // Krok 3: Mapowanie zadań do osób
        const mappedTasks = mapTasksToPeople(dailyData);
        console.log('Zadania przyporządkowane do osób (wraz z datą i dniem tygodnia):');
        console.log(mappedTasks);

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

        // Krok 7: Zapis podsumowania do pliku JSON w Cloud Storage
        console.log('\n--- Zapisuję podsumowanie do pliku JSON w Cloud Storage ---');
        const summaryEntry = {
            date: mappedTasks.date,
            dayOfWeek: mappedTasks.dayOfWeek,
            summary: finalSummary
        };
        // Zmieniono wywołanie funkcji na saveSummaryToGCS
        await saveSummaryToGCS(summaryEntry); 

        // Krok 8: Wysyłka podsumowania na adres e-mail
        console.log('\n--- Wysyłam podsumowanie na adres e-mail ---');
        const emailSubject = `Dzienne podsumowanie zadań na ${mappedTasks.dayOfWeek}, ${mappedTasks.date}`;
        await sendEmail(auth, RECIPIENT_EMAIL, emailSubject, finalSummary);

        console.log('\n--- Wszystkie zadania wykonane pomyślnie! ---');
        return "Zadania wykonane pomyślnie!"; // Zwróć sukces dla Cloud Run

      } else {
        console.log('Brak danych zadań dla bieżącego dnia w arkuszu. Zakończono bez generowania podsumowania.');
        return "Brak danych zadań dla bieżącego dnia.";
      }
    } else {
      console.log('Arkusz jest pusty lub nie zawiera danych do przetworzenia. Zakończono bez generowania podsumowania.');
      return "Arkusz jest pusty.";
    }

  } catch (err) {
    console.error('Wystąpił krytyczny błąd w aplikacji:', err.message);
    console.error('Szczegóły błędu:', err);
    console.error('Upewnij się, że wszystkie zmienne środowiskowe są poprawnie ustawione w Cloud Run (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI, GOOGLE_REFRESH_TOKEN, SPREADSHEET_ID, SHEET_NAME, RECIPIENT_EMAIL, GCS_BUCKET_NAME, OPENAI_API_KEY) oraz że konta serwisowe mają odpowiednie uprawnienia.');
    throw err; // Ważne, aby rzucić błąd, by Cloud Run zarejestrował nieudane wykonanie
  }
}

// --- Serwer HTTP dla Cloud Run ---
// Cloud Run oczekuje serwera HTTP, który będzie nasłuchiwał na określonym porcie.
// Cloud Scheduler będzie wysyłał żądania do tego endpointu, aby uruchomić aplikację.

const PORT = process.env.PORT || 8080; // Cloud Run dostarcza port przez zmienną środowiskową PORT

app.get('/', (req, res) => {
  // Prosta odpowiedź na żądanie GET, używana głównie do sprawdzenia, czy serwis działa
  res.status(200).send('Aplikacja Podsumowująca API jest aktywna. Użyj endpointu /run, aby uruchomić zadania.');
});

// Endpoint, który będzie wywoływany przez Cloud Scheduler (metoda POST)
app.post('/run', async (req, res) => {
  console.log('Otrzymano żądanie uruchomienia zadań z Cloud Scheduler.');
  try {
    const result = await runDailyTasks();
    res.status(200).send({ status: 'success', message: result });
  } catch (error) {
    console.error('Błąd podczas wykonywania zadań:', error);
    res.status(500).send({ status: 'error', message: error.message });
  }
});

// Uruchomienie serwera HTTP
app.listen(PORT, () => {
  console.log(`Aplikacja nasłuchuje na porcie ${PORT}`);
  console.log('--- UWAGA: To jest środowisko Cloud Run. Interaktywna autoryzacja OAuth nie jest wspierana. ---');
  console.log('--- Upewnij się, że GOOGLE_REFRESH_TOKEN jest ustawiony jako zmienna środowiskowa. ---');
});