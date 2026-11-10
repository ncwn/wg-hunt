# PLZ centre data

`plz-centres.ts` holds the centre of every German postal code (PLZ) wg-hunt can place a Place or an
Offer at without a coordinate, so nothing about a location is ever looked up online.

- **Source:** GeoNames postal codes for Germany, <https://download.geonames.org/export/zip/DE.zip>
  (file `DE.txt`), © GeoNames, <https://www.geonames.org>.
- **Licence:** [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/).
  Anyone may share and adapt the data, including commercially, as long as they give credit to
  GeoNames. The credit is in the project README and in the header of `plz-centres.ts`.
- **Changes made:** the file lists one line per PLZ (`<PLZ> <latitude> <longitude>`). A PLZ that
  GeoNames lists under several places is given the plain average of their positions, rounded to
  three decimals (about 100 m). The names, administrative regions and accuracy codes are dropped.
- **Regenerate:** download `DE.zip`, unzip `DE.txt`, then run
  `node scripts/build-plz-centres.mjs path/to/DE.txt`.
- **Accuracy:** GeoNames derives many positions from place names, so a centre can be a few
  kilometres from where a street in the PLZ really is. wg-hunt marks any distance that rests on a
  PLZ centre as approximate.
