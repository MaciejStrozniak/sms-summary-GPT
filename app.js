// app.js

// Importowanie niezbędnych modułów
const { google } = require('googleapis');
const path = require('path'); 
const fs = require('fs').promises; 
require('dotenv').config(); // Ładuje zmienne środowiskowe z pliku .env (tylko dla lokalnego dev/test)
const { Storage } = require('@google-cloud/storage'); 
const express = require('express'); // POPRAWKA TUTAJ: Usunięto zbędne ' = require'
const nodemailer = require('nodemailer'); // NOWY IMPORT: Nodemailer

const app = express();
app.use(express.json()); 

// --- Definicja stałych dla Cloud Storage ---
const SUMMARY_FILE_NAME = 'daily_summaries.json'; 

// --- Inicjalizacja Google Cloud Storage ---
const storage = new Storage();
let bucket; 
if (process.env.GCS_BUCKET_NAME) {
  bucket = storage.bucket(process.env.GCS_BUCKET_NAME);
}

// --- Zmienne środowiskowe dla autoryzacji SMTP (NOWE) ---
const SMTP_EMAIL_USER = process.env.SMTP_EMAIL_USER; // Adres e-mail nadawcy
const SMTP_EMAIL_PASS = process.env.SMTP_EMAIL_PASS; // Hasło do konta e-mail (lub hasło aplikacji dla Gmaila)


// --- Funkcje autoryzacji Google API (TYLKO KONTO SERWISOWE) ---

/**
 * Funkcja autoryzacji dla środowiska Cloud Run.
 * Automatycznie pobiera poświadczenia z środowiska Google Cloud dla Sheets i Storage.
 * @returns {Promise<Object>} Autoryzowany klient GoogleAuth.
 */
async function authorize() {
  const auth = new google.auth.GoogleAuth({
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets', 
      'https://www.googleapis.com/auth/devstorage.read_write' 
    ],
  });
  const client = await auth.getClient();
  console.log('Autoryzacja Google API dla Sheets/Storage zainicjowana za pomocą konta serwisowego.');
  return client;
}


// --- Narzędzia do obsługi Google Sheets (Arkuszy Google) ---

/**
 * Zwraca sformatowaną datę, opcjonalnie z przesunięciem dni.
 * @param {number} [dayOffset=0] - Liczba dni do dodania/odjęcia od bieżącej daty (np. -1 dla wczoraj, 1 dla jutra).
 * @returns {string} Bieżąca data sformatowana jako RRRR-MM-DD.
 */
function getFormattedDate(dayOffset = 0) {
  const date = new Date();
  date.setDate(date.getDate() + dayOffset); 
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Pobiera dane z określonego zakresu w Arkuszu Google.
 * @param {Object} auth - Obiekt autoryzacji Google (uzyskany z funkcji authorize()).
 * @param {string} spreadsheetId - ID Arkusza Google.
 * @param {string} range - Zakres komórek do pobrania (np. 'NazwaZakladki!A:Z').
 * @returns {Promise<Array<Array<string>>>} Tablica wierszy z danymi. Każdy wiersz to tablica komórek.
 */
async function getSheetData(auth, spreadsheetId, range) {
  const sheets = google.sheets({ version: 'v4', auth }); 
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId, 
      range,         
    });
    const rows = response.data.values; 
    if (!rows || rows.length === 0) {
      console.log('Nie znaleziono danych w arkuszu dla podanego zakresu.');
      return []; 
    }
    return rows;
  } catch (err) {
    console.error('Błąd podczas pobierania danych z Arkusza Google:', err.message);
    throw err; 
  }
}

/**
 * Dodaje nowy wiersz do Arkusza Google z podanymi danymi.
 * @param {Object} auth - Obiekt autoryzacji Google (uzyskany z funkcji authorize()).
 * @param {string} spreadsheetId - ID Arkusza Google.
 * @param {string} sheetName - Nazwa zakładki, do której ma być dodany wiersz.
 * @param {Array<string>} rowData - Tablica danych do dodania jako nowy wiersz.
 * @returns {Promise<Object>} Obiekt odpowiedzi z API.
 */
async function appendRowToSheet(auth, spreadsheetId, sheetName, rowData) {
  const sheets = google.sheets({ version: 'v4', auth });
  try {
    const response = await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${sheetName}!A:A`, 
      valueInputOption: 'USER_ENTERED', 
      resource: {
        values: [rowData], 
      },
    });
    console.log(`Pomyślnie dodano nowy wiersz do arkusza: ${spreadsheetId}, zakładka: ${sheetName}`);
    return response.data;
  } catch (err) {
    console.error('Błąd podczas dodawania nowego wiersza do Arkusza Google:', err.message);
    throw err;
  }
}

/**
 * Filtruje wiersze pobrane z arkusza, zwracając tylko te, które pasują do podanej daty.
 * Zakłada, że data do porównania znajduje się w PIERWSZEJ KOLUMNIE (indeks 0).
 * Funkcja próbuje sparsować datę z komórki i porównać ją z podaną datą.
 * @param {Array<Array<string>>} rows - Wszystkie wiersze pobrane z arkusza (włączając nagłówki).
 * @param {string} targetDateFormatted - Data w formacie RRRR-MM-DD do filtrowania.
 * @returns {Array<Array<string>>>} Tablica wierszy pasujących do podanej daty, z zachowanymi nagłówkami.
 */
function filterDailyData(rows, targetDateFormatted) {
  console.log(`Filtruję dane z arkusza dla daty: ${targetDateFormatted}`);

  const headers = rows.length > 0 ? rows[0] : [];
  const dataRows = rows.length > 1 ? rows.slice(1) : []; 

  const dailyData = dataRows.filter(row => {
    if (row && row.length > 0 && row[0]) {
      try {
        const cellDate = new Date(row[0]);
        if (isNaN(cellDate.getTime())) {
          return false;
        }

        const cellYear = cellDate.getFullYear();
        const cellMonth = (cellDate.getMonth() + 1).toString().padStart(2, '0');
        const cellDay = cellDate.getDate().toString().padStart(2, '0'); 
        const cellFormattedDate = `${cellYear}-${cellMonth}-${cellDay}`;

        return cellFormattedDate === targetDateFormatted;
      } catch (e) {
        return false; 
      }
    }
    return false;
  });

  return headers.length > 0 ? [headers, ...dailyData] : dailyData;
}

/**
 * Mapuje zadania do odpowiednich osób na podstawie danych z Arkusza Google,
 * dodając datę i nazwę dnia tygodnia.
 * Oczekuje formatu danych: [[Nagłówek1, Osoba1, Osoba2], [Data, Zadanie1, Zadanie2]]
 * @param {Array<Array<string>>} dailyData - Sfiltrowane dane dla bieżącego dnia (włączając nagłówki).
 * @returns {Object} Obiekt zawierający datę, nazwę dnia tygodnia i zadania przyporządkowane do osób.
 */
function mapTasksToPeople(dailyData) {
  if (!dailyData || dailyData.length < 2) {
    console.warn('Brak wystarczających danych do mapowania zadań na osoby. Oczekiwano nagłówków i co najmniej jednego wiersza danych.');
    return { date: null, dayOfWeek: null, tasksByPerson: {} };
  }

  const headers = dailyData[0]; 
  const taskRow = dailyData[1];  

  const personTasks = {};
  let date = null;
  let dayOfWeek = null;

  if (taskRow && taskRow.length > 0 && taskRow[0]) {
    try {
      const taskDate = new Date(taskRow[0]);
      if (!isNaN(taskDate.getTime())) {
        date = taskDate.toISOString().split('T')[0]; 
        dayOfWeek = taskDate.toLocaleDateString('pl-PL', { weekday: 'long' }); 
      }
    } catch (e) {
      console.warn(`Nie udało się sparsować daty z wiersza zadań: ${taskRow[0]}. Błąd: ${e.message}`);
    }
  }

  for (let i = 1; i < headers.length; i++) {
    const personName = headers[i];
    const task = taskRow[i];

    if (personName && task) { 
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
  const originalToPlaceholderMap = {}; 
  const placeholderToOriginalMap = {}; 
  let employeeCounter = 0; 

  const anonymizedTasksByPerson = {};
  
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

  const anonymizedTasksContent = {};
  for (const placeholder in anonymizedTasksByPerson) {
      let taskDescription = anonymizedTasksByPerson[placeholder];
      
      for (const originalName in originalToPlaceholderMap) {
          const namePlaceholder = originalToPlaceholderMap[originalName];
          const regex = new RegExp(`\\b${originalName}\\b`, 'gi'); 
          taskDescription = taskDescription.replace(regex, namePlaceholder);
      }
      anonymizedTasksContent[placeholder] = taskDescription;
  }

  const anonymizedData = {
    date: data.date,
    dayOfWeek: data.dayOfWeek,
    tasksByPerson: anonymizedTasksContent 
  };

  return {
    anonymizedData,
    personalDataMap: placeholderToOriginalMap 
  };
}


/**
 * De-anonimizuje tekst, zastępując placeholdery z powrotem oryginalnymi danymi.
 * Funkcja została ulepszona, aby radzić sobie z różnymi formatami placeholderów
 * generowanych przez LLM (np. "Pracownik 1" zamiast "pracownik_1").
 * @param {string} anonymizedText - Tekst z placeholderami (np. podsumowanie z LLM).
 * @param {Object} personalDataMap - Mapowanie { placeholder: oryginalneDane }.
 * @returns {string} Tekst z przywróconymi oryginalnymi danymi.
 */
function deanonymizeSummary(anonymizedText, personalDataMap) {
  let deAnonymizedText = anonymizedText;
  for (const placeholder in personalDataMap) {
    const originalData = personalDataMap[placeholder];
    
    const parts = placeholder.split('_');
    if (parts.length === 2) {
      const baseName = parts[0]; 
      const number = parts[1];   

      const flexibleRegex = new RegExp(
        `\\b[${baseName[0].toLowerCase()}${baseName[0].toUpperCase()}]` +
        `${baseName.substring(1)}[_ ]${number}\\b`, 
        'gi' 
      );
      
      deAnonymizedText = deAnonymizedText.replace(flexibleRegex, originalData);
    } else {
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
  const apiKey = process.env.OPENAI_API_KEY; 

  if (!apiKey) {
    throw new Error('BŁĄD: Klucz OPENAI_API_KEY nie został ustawiony w pliku .env!');
  }

  const apiUrl = 'https://api.openai.com/v1/chat/completions'; 

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
    model: "gpt-3.5-turbo", 
    messages: [
      { role: "system", content: "Jesteś pomocnym asystentem, który generuje zwięzłe podsumowania zadań." },
      { role: "user", content: prompt }
    ],
    temperature: 0.7, 
    max_tokens: 100,  
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
        'Authorization': `Bearer ${apiKey}` 
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
    return [];
  }
}

/**
 * Zapisuje (aktualizuje) plik JSON z codziennymi podsumowaniami w Google Cloud Storage.
 * Nowe podsumowanie jest dodawane do istniejącej tablicy.
 * @param {Object} summaryData - Obiekt z danymi do zapisu (np. { date, dayOfWeek, summary: finalSummary }).
 */
async function saveSummaryToGCS(summaryData) {
  if (!process.env.GCS_BUCKET_NAME) { 
    throw new Error('BŁĄD: Nazwa zasobnika Cloud Storage (GCS_BUCKET_NAME) nie została ustawiona w zmiennych środowiskowych!');
  }

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


// --- Narzędzia do wysyłki e-maili (SMTP z Nodemailer) ---

/**
 * Wysyła wiadomość e-mail za pośrednictwem SMTP (Nodemailer).
 * @param {string} senderEmail - Adres e-mail nadawcy (SMTP_EMAIL_USER).
 * @param {string} senderPassword - Hasło nadawcy (SMTP_EMAIL_PASS).
 * @param {string} recipientEmail - Adres e-mail odbiorcy.
 * @param {string} subject - Temat wiadomości.
 * @param {string} body - Treść wiadomości (zwykły tekst).
 */
async function sendEmail(senderEmail, senderPassword, recipientEmail, subject, body) {
  if (!senderEmail || !senderPassword) {
    throw new Error('BŁĄD: Brak zmiennych środowiskowych SMTP_EMAIL_USER lub SMTP_EMAIL_PASS. Wysyłka e-maila SMTP niemożliwa.');
  }

  // Konfiguracja transportera Nodemailer dla Gmaila
  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false, // true dla 465, false dla innych portów (np. 587 z STARTTLS)
    auth: {
      user: senderEmail,
      pass: senderPassword,
    },
    tls: {
        rejectUnauthorized: false // Ważne dla niektórych środowisk, ale lepiej unikać w produkcji
    }
  });

  const mailOptions = {
    from: senderEmail,
    to: recipientEmail,
    subject: subject,
    text: body,
  };

  console.log(`Wysyłam e-mail z ${senderEmail} do ${recipientEmail}...`);
  try {
    const info = await transporter.sendMail(mailOptions);
    console.log('E-mail pomyślnie wysłany. ID wiadomości: %s', info.messageId);
    return info;
  } catch (err) {
    console.error(`Błąd podczas wysyłania e-maila do ${recipientEmail} przez SMTP:`, err.message);
    // Wypisz więcej szczegółów błędu Nodemailer, jeśli dostępne
    if (err.response) {
      console.error('Odpowiedź SMTP:', err.response);
    }
    throw err;
  }
}


// --- Główna logika biznesowa aplikacji ---
async function runDailyTasks() {
  let serviceAccountAuthClient; // Zmienna będzie przechowywać klienta autoryzacji konta serwisowego
  try {
    // Krok 1: Autoryzacja do Google API za pomocą konta serwisowego (dla Sheets/Storage)
    serviceAccountAuthClient = await authorize(); 
    console.log('Autoryzacja Google API dla Sheets/Storage pomyślna!');

    // --- Konfiguracja Arkusza Google i e-maila pobrana ze zmiennych środowiskowych ---
    const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
    const SHEET_NAME = process.env.SHEET_NAME;
    const RANGE = `${SHEET_NAME}!A:Z`; 
    const RECIPIENT_EMAIL = process.env.RECIPIENT_EMAIL; 
    const GCS_BUCKET_NAME = process.env.GCS_BUCKET_NAME; 
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const SENDER_EMAIL = process.env.SMTP_EMAIL_USER; // Nowa zmienna dla nadawcy SMTP
    const SENDER_PASSWORD = process.env.SMTP_EMAIL_PASS; // Nowa zmienna dla hasła SMTP

    // Sprawdzanie, czy wszystkie niezbędne zmienne środowiskowe są ustawione
    if (!SPREADSHEET_ID || !SHEET_NAME || !RECIPIENT_EMAIL || !GCS_BUCKET_NAME || !OPENAI_API_KEY || !SENDER_EMAIL || !SENDER_PASSWORD) {
      console.error('BŁĄD: Brakuje jednej lub więcej zmiennych środowiskowych (SPREADSHEET_ID, SHEET_NAME, RECIPIENT_EMAIL, GCS_BUCKET_NAME, OPENAI_API_KEY, SMTP_EMAIL_USER, SMTP_EMAIL_PASS). Upewnij się, że są ustawione w konfiguracji Cloud Run.');
      throw new Error('Brak niezbędnych zmiennych środowiskowych do uruchomienia aplikacji.');
    }

    // Nowa logika: Pobieranie danych z dnia poprzedniego
    const previousDayFormatted = getFormattedDate(-1); 
    console.log(`Pobieram wszystkie dane z arkusza: ${SPREADSHEET_ID}, zakres: ${RANGE} dla dnia: ${previousDayFormatted}`);
    // Używamy serviceAccountAuthClient do Arkuszy Google
    const allRows = await getSheetData(serviceAccountAuthClient, SPREADSHEET_ID, RANGE);

    let finalSummary = "Brak danych zadań dla dnia poprzedniego."; 

    if (allRows.length > 0) {
      console.log(`Pobrano ${allRows.length} wierszy danych z arkusza.`);

      // Krok 2: Filtrowanie danych dla dnia poprzedniego
      const dailyData = filterDailyData(allRows, previousDayFormatted); 

      if (dailyData.length > 1) { 
        console.log(`Znaleziono ${dailyData.length - 1} wierszy danych zadań dla dnia poprzedniego.`);

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
        finalSummary = deanonymizeSummary(anonymizedSummaryFromLLM, personalDataMap);
        console.log('Ostateczne podsumowanie (po de-anonimizacji):');
        console.log(finalSummary);

        // Krok 7: Zapis podsumowania do pliku JSON w Cloud Storage
        console.log('\n--- Zapisuję podsumowanie do pliku JSON w Cloud Storage ---');
        const summaryEntry = {
            date: mappedTasks.date,
            dayOfWeek: mappedTasks.dayOfWeek,
            summary: finalSummary
        };
        // Używamy serviceAccountAuthClient do Cloud Storage
        await saveSummaryToGCS(summaryEntry); 

        // Krok 8: Wysyłka podsumowania na adres e-mail (TERAZ PRZEZ SMTP)
        console.log('\n--- Wysyłam podsumowanie na adres e-mail (przez SMTP) ---');
        const emailSubject = `Dzienne podsumowanie zadań na ${mappedTasks.dayOfWeek}, ${mappedTasks.date}`;
        // Używamy nowych zmiennych SMTP_EMAIL_USER i SMTP_EMAIL_PASS
        await sendEmail(SENDER_EMAIL, SENDER_PASSWORD, RECIPIENT_EMAIL, emailSubject, finalSummary);

      } else {
        console.log('Brak danych zadań dla dnia poprzedniego w arkuszu. Nie generuję podsumowania ani nie wysyłam e-maila.');
      }
    } else {
      console.log('Arkusz jest pusty lub nie zawiera danych do przetworzenia. Nie generuję podsumowania ani nie wysyłam e-maila.');
    }

    // Nowa funkcja: Dodawanie nowego wiersza z bieżącą datą
    const currentDayFormatted = getFormattedDate(0); 
    const currentDayOfWeek = new Date().toLocaleDateString('pl-PL', { weekday: 'long' }); 
    const newRowData = [currentDayFormatted, '', '']; 
    
    console.log(`\n--- Dodaję nowy wiersz z datą ${currentDayFormatted} do arkusza ---`);
    // Używamy serviceAccountAuthClient do Arkuszy Google
    await appendRowToSheet(serviceAccountAuthClient, SPREADSHEET_ID, SHEET_NAME, newRowData);

    console.log('\n--- Wszystkie zadania wykonane pomyślnie! ---');
    return "Zadania wykonane pomyślnie!"; 

  } catch (err) {
    console.error('Wystąpił krytyczny błąd w aplikacji:', err.message);
    console.error('Szczegóły błędu:', err);
    console.error('Upewnij się, że wszystkie zmienne środowiskowe są poprawnie ustawione w Cloud Run (SPREADSHEET_ID, SHEET_NAME, RECIPIENT_EMAIL, GCS_BUCKET_NAME, OPENAI_API_KEY, SMTP_EMAIL_USER, SMTP_EMAIL_PASS) oraz że konta serwisowe mają odpowiednie uprawnienia.');
    throw err; 
  }
}

// --- Serwer HTTP dla Cloud Run ---
const PORT = process.env.PORT || 8080; 

app.get('/', (req, res) => {
  res.status(200).send('Aplikacja Podsumowująca API jest aktywna. Użyj endpointu /run, aby uruchomić zadania.');
});

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

app.listen(PORT, () => {
  console.log(`Aplikacja nasłuchuje na porcie ${PORT}`);
  console.log('--- UWAGA: Aplikacja używa autoryzacji konta serwisowego dla Google Sheets/Storage i SMTP dla e-maili. ---');
  console.log('--- Upewnij się, że konto serwisowe Cloud Run ma odpowiednie role IAM dla Sheets/Storage. ---');
  console.log('--- Upewnij się, że zmienne SMTP_EMAIL_USER i SMTP_EMAIL_PASS są poprawne. ---');
});