# ETAP 1: BUDOWANIE (instalujemy tylko zależności produkcyjne)
# Używamy minimalnego obrazu Node.js 20-alpine jako bazy do instalacji zależności.
FROM node:20-alpine as builder

# Ustawiamy katalog roboczy.
WORKDIR /usr/src/app

# Kopiujemy pliki manifestów.
COPY package*.json ./

# Instalujemy tylko zależności produkcyjne, co znacząco zmniejszy rozmiar finalnego obrazu.
# Używamy `npm ci` dla szybszych i bardziej powtarzalnych kompilacji (wymaga package-lock.json).
RUN npm ci --omit=dev

# Kopiujemy resztę plików aplikacji.
COPY . .


# ETAP 2: KOŃCOWY OBRAZ
# Zaczynamy od nowego, czystego obrazu node:20-alpine.
FROM node:20-alpine

# Ustawiamy katalog roboczy.
WORKDIR /usr/src/app

# Kopiujemy pliki manifestów.
COPY package*.json ./

# Kopiujemy tylko folder node_modules i pliki aplikacji z etapu "builder".
# Dzięki temu w finalnym obrazie znajdą się tylko niezbędne pliki.
COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/src/app .

# W Cloud Run, aplikacja musi nasłuchiwać na porcie zdefiniowanym przez zmienną środowiskową PORT.
EXPOSE 8080

# Definiujemy komendę, która zostanie wykonana po uruchomieniu kontenera.
# Używamy `node app.js`, aby uniknąć zależności od skryptów `npm`.
CMD [ "node", "app.js" ]


# # ETAP 1: BUDOWANIE
# # Używamy obrazu Node.js 20-alpine jako bazy do instalacji zależności
# FROM node:20-alpine as builder

# # Ustawiamy katalog roboczy
# WORKDIR /usr/src/app

# # Kopiujemy pliki package.json i package-lock.json
# COPY package*.json ./

# # Instalujemy wszystkie zależności (w tym produkcyjne i deweloperskie)
# # Ta warstwa jest tymczasowa i nie znajdzie się w finalnym obrazie
# RUN npm install

# # Kopiujemy resztę plików aplikacji
# COPY . .


# # ETAP 2: KOŃCOWY OBRAZ
# # Zaczynamy od nowego, czystego obrazu Node.js 20-alpine
# # Ten obraz będzie zawierał tylko to, co niezbędne do uruchomienia aplikacji
# FROM node:20-alpine

# # Ustawiamy katalog roboczy
# WORKDIR /usr/src/app

# # Kopiujemy gotowe zależności z etapu "builder"
# # Używamy --omit=dev, aby upewnić się, że nie kopiujemy deweloperskich zależności
# COPY --from=builder /usr/src/app/node_modules ./node_modules

# # Kopiujemy gotowe pliki aplikacji z etapu "builder"
# COPY --from=builder /usr/src/app .

# # W Cloud Run, aplikacja musi nasłuchiwać na porcie zdefiniowanym przez zmienną środowiskową PORT.
# EXPOSE 8080

# # Definiujemy komendę, która zostanie wykonana po uruchomieniu kontenera.
# # Zwróć uwagę, że nie potrzebujemy już "npm start", ponieważ aplikacja jest już gotowa.
# CMD [ "node", "app.js" ]


# # Używamy oficjalnego obrazu Node.js jako bazy.
# # Wybieramy wersję slim, aby obraz był jak najmniejszy, co przyspiesza wdrożenie.
# # FROM node:20-slim
# # FROM node:lts-slim
# FROM node:20-alpine

# # Ustawiamy katalog roboczy wewnątrz kontenera.
# # Wszystkie dalsze operacje (COPY, RUN, CMD) będą wykonywane w tym katalogu.
# WORKDIR /usr/src/app

# # Kopiujemy pliki package.json i package-lock.json do katalogu roboczego.
# # Te pliki są kopiowane osobno, aby Docker mógł użyć warstwy cache dla npm install,
# # jeśli zależności się nie zmienią, co przyspiesza budowanie.
# COPY package*.json ./

# # Instalujemy zależności Node.js.
# # `--production` instaluje tylko zależności z sekcji "dependencies", pomijając "devDependencies",
# # co dodatkowo zmniejsza rozmiar obrazu.
# RUN npm install --production

# # Kopiujemy pozostałe pliki aplikacji do katalogu roboczego.
# # Teraz, gdy zależności są już zainstalowane, kopiujemy resztę kodu źródłowego.
# COPY . .

# # W Cloud Run, aplikacja musi nasłuchiwać na porcie zdefiniowanym przez zmienną środowiskową PORT.
# # Domyślnie w naszym kodzie to 8080. Ta instrukcja informuje Docker, że kontener nasłuchuje na tym porcie.
# EXPOSE 8080

# # Definiujemy komendę, która zostanie wykonana po uruchomieniu kontenera.
# # `npm start` (zdefiniowane w package.json) uruchomi `node app.js`.
# CMD [ "npm", "start" ]