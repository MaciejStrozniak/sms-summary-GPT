# Używamy oficjalnego obrazu Node.js jako bazy.
# Wybieramy wersję slim, aby obraz był jak najmniejszy, co przyspiesza wdrożenie.
# FROM node:20-slim
FROM node:lts-slim

# Ustawiamy katalog roboczy wewnątrz kontenera.
# Wszystkie dalsze operacje (COPY, RUN, CMD) będą wykonywane w tym katalogu.
WORKDIR /usr/src/app

# Kopiujemy pliki package.json i package-lock.json do katalogu roboczego.
# Te pliki są kopiowane osobno, aby Docker mógł użyć warstwy cache dla npm install,
# jeśli zależności się nie zmienią, co przyspiesza budowanie.
COPY package*.json ./

# Instalujemy zależności Node.js.
# `--production` instaluje tylko zależności z sekcji "dependencies", pomijając "devDependencies",
# co dodatkowo zmniejsza rozmiar obrazu.
RUN npm install --production

# Kopiujemy pozostałe pliki aplikacji do katalogu roboczego.
# Teraz, gdy zależności są już zainstalowane, kopiujemy resztę kodu źródłowego.
COPY . .

# W Cloud Run, aplikacja musi nasłuchiwać na porcie zdefiniowanym przez zmienną środowiskową PORT.
# Domyślnie w naszym kodzie to 8080. Ta instrukcja informuje Docker, że kontener nasłuchuje na tym porcie.
EXPOSE 8080

# Definiujemy komendę, która zostanie wykonana po uruchomieniu kontenera.
# `npm start` (zdefiniowane w package.json) uruchomi `node app.js`.
CMD [ "npm", "start" ]