# Thuishaven

Een persoonlijke startpagina voor je eigen server. Donkere glazen kaarten over een
getekend bergmeer, waarvan de lucht het echte weer bij jou thuis volgt: zon en maan
staan waar ze nu staan, wolken drijven met de wind mee, en bij regen, sneeuw, mist
of onweer zie je dat ook op je scherm.

## Wat zit erin

- **Startscherm**: klok, begroeting, het weer van nu en een zoekbalk (druk op `/`;
  `!yt`, `!w`, `!maps`, `!gh` en `!r` zoeken direct op die site).
- **Snelkoppelingen** als tegels met het icoon van de site. Vink "status" aan bij
  diensten op je eigen netwerk en je ziet of ze bereikbaar zijn en hoe snel.
- **Serverbalk**: processor, geheugen, schijf, temperatuur en hoe lang de server aan staat.
- **Proxmox**: per server de processor, het geheugen, de schijf en welke VM's en
  containers draaien. Voeg je servers toe bij Instellingen met een API-token dat alleen
  mag kijken (rol PVEAuditor). Het geheim blijft op de server en komt niet in de browser.
- **Weer** (per uur en per dag), **te doen**, een **kladblok** en **nieuws** uit je
  eigen RSS-bronnen.
- **Vijf landschappen**: bergmeer, hooggebergte, heuvelland, woestijn en eilanden, te kiezen
  met de knop Achtergrond. Het weer en het licht kloppen in elk landschap.
- **Rit**: rijd ik droog? Kies van waar naar waar je rijdt en op welke dag en tijd (handig
  op de motor of fiets). Het dashboard zoekt de snelste route en een paar omwegen, kleurt
  elke route per stuk weg naar de regen die er valt op het moment dat jij daar langskomt,
  en raadt de droogste route en het droogste vertrekmoment aan. Binnen twee uur komt de
  regen per vijf minuten van Buienradar, verder vooruit (tot drie dagen) van Open-Meteo.
  Files worden niet gemeten; je kiest zelf tussen je normale en je drukke reistijd.
- **Wereldbol** op een eigen scherm: satellietbeelden waarop je tot straatniveau inzoomt,
  een nachtstand met stadslichten, punten voor waar je bent geweest of nog heen wilt,
  bezochte landen die oplichten, de afstand tot huis en waar het ISS nu vliegt.
- **Backup**: download al je gegevens als één bestand en zet ze later terug.

## Installeren op Ubuntu Server

```bash
curl -fsSL https://raw.githubusercontent.com/TimonNL2/thuishaven/main/install.sh | sudo bash
```

Daarna staat het dashboard op `http://<ip-van-je-server>:8080` en start het vanzelf
mee met de server. Hetzelfde commando nog een keer draaien werkt het bij; je gegevens
blijven staan in `/opt/thuishaven/data`.

Een andere poort kies je zo:

```bash
curl -fsSL https://raw.githubusercontent.com/TimonNL2/thuishaven/main/install.sh | sudo PORT=80 bash
```

Stel het adres in je browser in als startpagina, of zet het vast als eerste tabblad.

## Zelf draaien of aanpassen

Er is niets te installeren behalve Python 3.8 of nieuwer:

```bash
python3 server.py
```

Een bepaalde lucht bekijken kan met `?lucht=sneeuw&uur=23` achter het adres (en `&landschap=woestijn` voor een ander landschap)
(helder, halfbewolkt, bewolkt, motregen, regen, sneeuw, mist of onweer).

## Goed om te weten

- Het dashboard heeft geen inlog. Gebruik het op je thuisnetwerk of achter een VPN,
  niet open aan het internet.
- Bibliotheken, kaartgrenzen en lettertypes worden één keer opgehaald en daarna vanaf
  je eigen server geserveerd. Je browser haalt zelf het weer op bij Open-Meteo, de
  satellietbeelden bij Esri en NASA, de positie van het ISS bij wheretheiss.at, en voor
  een rit de route bij OSRM, de kaart bij OpenStreetMap en de radar bij RainViewer.
- Verwijderen: `sudo systemctl disable --now thuishaven`, daarna
  `/etc/systemd/system/thuishaven.service` en `/opt/thuishaven` weghalen.
