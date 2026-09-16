# Bundled font inventory

The machine-readable source of truth is [`font-inventory.json`](font-inventory.json). It maps all 35 bundled families and all 322 tracked font binaries across Control Panel and UI to:

- the immutable Google Fonts commit `77669fa9a8a89271bce79dfc05fd2529efb1a187`;
- the family upstream directory and immutable license-source URL;
- the applicable OFL-1.1 or Apache-2.0 license; and
- each distributed path, byte size, and SHA-256 digest.

The bundled CSS uses Google Fonts subset conventions. All 157 Control Panel and 167 UI font references resolve to packaged files. The inventory records bundled-file identity rather than asserting that each local renamed subset is byte-identical to the latest upstream build. Public release review should retain the inventory and canonical license texts under `legal/text/fonts/`.

## Family notices

The following copyright and reserved-name statements are copied from each family’s immutable upstream license source. The source link is authoritative if punctuation or formatting matters.

- **Abril Fatface** (OFL-1.1): Copyright (c) 2011, TypeTogether (www.type-together.com), with Reserved Font Names "Abril" and "Abril Fatface" [Source](https://github.com/google/fonts/blob/77669fa9a8a89271bce79dfc05fd2529efb1a187/ofl/abrilfatface/OFL.txt)
- **Archivo Black** (OFL-1.1): Copyright 2017 The Archivo Black Project Authors (https://github.com/Omnibus-Type/ArchivoBlack) [Source](https://github.com/google/fonts/blob/77669fa9a8a89271bce79dfc05fd2529efb1a187/ofl/archivoblack/OFL.txt)
- **Audiowide** (OFL-1.1): Copyright (c) 2012, Brian J. Bonislawsky DBA Astigmatic (AOETI) (astigma@astigmatic.com), with Reserved Font Names "Audiowide" [Source](https://github.com/google/fonts/blob/77669fa9a8a89271bce79dfc05fd2529efb1a187/ofl/audiowide/OFL.txt)
- **Bangers** (OFL-1.1): Copyright 2010 The Bangers Project Authors (https://github.com/googlefonts/bangers) [Source](https://github.com/google/fonts/blob/77669fa9a8a89271bce79dfc05fd2529efb1a187/ofl/bangers/OFL.txt)
- **Bebas Neue** (OFL-1.1): Copyright © 2010 by Dharma Type. [Source](https://github.com/google/fonts/blob/77669fa9a8a89271bce79dfc05fd2529efb1a187/ofl/bebasneue/OFL.txt)
- **Black Ops One** (OFL-1.1): Copyright 2022 The Black-Ops Project Authors (https://github.com/googlefonts/googlefonts-project-template) [Source](https://github.com/google/fonts/blob/77669fa9a8a89271bce79dfc05fd2529efb1a187/ofl/blackopsone/OFL.txt)
- **Bungee** (OFL-1.1): Copyright 2023 The Bungee Project Authors (https://github.com/djrrb/Bungee) [Source](https://github.com/google/fonts/blob/77669fa9a8a89271bce79dfc05fd2529efb1a187/ofl/bungee/OFL.txt)
- **Caveat** (OFL-1.1): Copyright 2014 The Caveat Project Authors (https://github.com/googlefonts/caveat) [Source](https://github.com/google/fonts/blob/77669fa9a8a89271bce79dfc05fd2529efb1a187/ofl/caveat/OFL.txt)
- **Cinzel** (OFL-1.1): Copyright 2020 The Cinzel Project Authors (https://github.com/NDISCOVER/Cinzel) [Source](https://github.com/google/fonts/blob/77669fa9a8a89271bce79dfc05fd2529efb1a187/ofl/cinzel/OFL.txt)
- **Comfortaa** (OFL-1.1): Copyright 2011 The Comfortaa Project Authors (https://github.com/alexeiva/comfortaa), with Reserved Font Name "Comfortaa". [Source](https://github.com/google/fonts/blob/77669fa9a8a89271bce79dfc05fd2529efb1a187/ofl/comfortaa/OFL.txt)
- **Creepster** (OFL-1.1): Copyright (c) 2011, Font Diner, Inc (diner@fontdiner.com), with Reserved Font Names "Creepster" [Source](https://github.com/google/fonts/blob/77669fa9a8a89271bce79dfc05fd2529efb1a187/ofl/creepster/OFL.txt)
- **Dancing Script** (OFL-1.1): Copyright 2016 The Dancing Script Project Authors (https://github.com/googlefonts/DancingScript), with Reserved Font Name 'Dancing Script'. [Source](https://github.com/google/fonts/blob/77669fa9a8a89271bce79dfc05fd2529efb1a187/ofl/dancingscript/OFL.txt)
- **Fredoka** (OFL-1.1): Copyright 2016 The Fredoka Project Authors (https://github.com/hafontia/Fredoka-One) [Source](https://github.com/google/fonts/blob/77669fa9a8a89271bce79dfc05fd2529efb1a187/ofl/fredoka/OFL.txt)
- **Great Vibes** (OFL-1.1): Copyright 2015 The Great Vibes Pro Project Authors (https://github.com/googlefonts/great-vibes) [Source](https://github.com/google/fonts/blob/77669fa9a8a89271bce79dfc05fd2529efb1a187/ofl/greatvibes/OFL.txt)
- **Inter** (OFL-1.1): Copyright 2020 The Inter Project Authors (https://github.com/rsms/inter) [Source](https://github.com/google/fonts/blob/77669fa9a8a89271bce79dfc05fd2529efb1a187/ofl/inter/OFL.txt)
- **JetBrains Mono** (OFL-1.1): Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono) [Source](https://github.com/google/fonts/blob/77669fa9a8a89271bce79dfc05fd2529efb1a187/ofl/jetbrainsmono/OFL.txt)
- **Lobster** (OFL-1.1): Copyright 2010 The Lobster Project Authors (https://github.com/impallari/The-Lobster-Font), with Reserved Font Name "Lobster". [Source](https://github.com/google/fonts/blob/77669fa9a8a89271bce79dfc05fd2529efb1a187/ofl/lobster/OFL.txt)
- **Monoton** (OFL-1.1): Copyright (c) 2011 by vernon adams (vern@newtypography.co.uk), with Reserved Font Names "Monoton" [Source](https://github.com/google/fonts/blob/77669fa9a8a89271bce79dfc05fd2529efb1a187/ofl/monoton/OFL.txt)
- **Montserrat** (OFL-1.1): Copyright 2024 The Montserrat.Git Project Authors (https://github.com/JulietaUla/Montserrat.git) [Source](https://github.com/google/fonts/blob/77669fa9a8a89271bce79dfc05fd2529efb1a187/ofl/montserrat/OFL.txt)
- **Orbitron** (OFL-1.1): Copyright 2018 The Orbitron Project Authors (https://github.com/theleagueof/orbitron), with Reserved Font Name: "Orbitron" [Source](https://github.com/google/fonts/blob/77669fa9a8a89271bce79dfc05fd2529efb1a187/ofl/orbitron/OFL.txt)
- **Oswald** (OFL-1.1): Copyright 2016 The Oswald Project Authors (https://github.com/googlefonts/OswaldFont) [Source](https://github.com/google/fonts/blob/77669fa9a8a89271bce79dfc05fd2529efb1a187/ofl/oswald/OFL.txt)
- **Outfit** (OFL-1.1): Copyright 2021 The Outfit Project Authors (https://github.com/Outfitio/Outfit-Fonts) [Source](https://github.com/google/fonts/blob/77669fa9a8a89271bce79dfc05fd2529efb1a187/ofl/outfit/OFL.txt)
- **Pacifico** (OFL-1.1): Copyright 2018 The Pacifico Project Authors (https://github.com/googlefonts/Pacifico) [Source](https://github.com/google/fonts/blob/77669fa9a8a89271bce79dfc05fd2529efb1a187/ofl/pacifico/OFL.txt)
- **Permanent Marker** (Apache-2.0): Licensed under Apache License 2.0; the immutable upstream source carries the applicable copyright and attribution metadata. [Source](https://github.com/google/fonts/blob/77669fa9a8a89271bce79dfc05fd2529efb1a187/apache/permanentmarker/LICENSE.txt)
- **Playfair Display** (OFL-1.1): Copyright 2017 The Playfair Display Project Authors (https://github.com/clauseggers/Playfair-Display), with Reserved Font Name "Playfair Display" [Source](https://github.com/google/fonts/blob/77669fa9a8a89271bce79dfc05fd2529efb1a187/ofl/playfairdisplay/OFL.txt)
- **Plus Jakarta Sans** (OFL-1.1): Copyright 2020 The Plus Jakarta Sans Project Authors (https://github.com/tokotype/PlusJakartaSans) [Source](https://github.com/google/fonts/blob/77669fa9a8a89271bce79dfc05fd2529efb1a187/ofl/plusjakartasans/OFL.txt)
- **Poppins** (OFL-1.1): Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins) [Source](https://github.com/google/fonts/blob/77669fa9a8a89271bce79dfc05fd2529efb1a187/ofl/poppins/OFL.txt)
- **Press Start 2P** (OFL-1.1): Copyright 2012 The Press Start 2P Project Authors (cody@zone38.net), with Reserved Font Name "Press Start 2P". [Source](https://github.com/google/fonts/blob/77669fa9a8a89271bce79dfc05fd2529efb1a187/ofl/pressstart2p/OFL.txt)
- **Quicksand** (OFL-1.1): Copyright 2011 The Quicksand Project Authors (https://github.com/andrew-paglinawan/QuicksandFamily), with Reserved Font Name “Quicksand”. [Source](https://github.com/google/fonts/blob/77669fa9a8a89271bce79dfc05fd2529efb1a187/ofl/quicksand/OFL.txt)
- **Raleway** (OFL-1.1): Copyright 2010 The Raleway Project Authors (impallari@gmail.com), with Reserved Font Name "Raleway". [Source](https://github.com/google/fonts/blob/77669fa9a8a89271bce79dfc05fd2529efb1a187/ofl/raleway/OFL.txt)
- **Righteous** (OFL-1.1): Copyright (c) 2011 by Brian J. Bonislawsky DBA Astigmatic (AOETI) (astigma@astigmatic.com), with Reserved Font Names "Righteous" [Source](https://github.com/google/fonts/blob/77669fa9a8a89271bce79dfc05fd2529efb1a187/ofl/righteous/OFL.txt)
- **Russo One** (OFL-1.1): Copyright (c) 2011-2012, Jovanny Lemonad (jovanny.ru), with Reserved Font Name "Russo" [Source](https://github.com/google/fonts/blob/77669fa9a8a89271bce79dfc05fd2529efb1a187/ofl/russoone/OFL.txt)
- **Satisfy** (Apache-2.0): Licensed under Apache License 2.0; the immutable upstream source carries the applicable copyright and attribution metadata. [Source](https://github.com/google/fonts/blob/77669fa9a8a89271bce79dfc05fd2529efb1a187/apache/satisfy/LICENSE.txt)
- **Space Grotesk** (OFL-1.1): Copyright 2020 The Space Grotesk Project Authors (https://github.com/floriankarsten/space-grotesk) [Source](https://github.com/google/fonts/blob/77669fa9a8a89271bce79dfc05fd2529efb1a187/ofl/spacegrotesk/OFL.txt)
- **Titan One** (OFL-1.1): Copyright (c) 2011, Rodrigo Fuenzalida (www.rfuenzalida.com|hello@rfuenzalida.com), with Reserved Font Name Titan. [Source](https://github.com/google/fonts/blob/77669fa9a8a89271bce79dfc05fd2529efb1a187/ofl/titanone/OFL.txt)

The current mapping resolves the ordinary engineering requirement for immutable source, checksum, and license coverage. A legal decision is needed only if distribution under OFL-1.1 or Apache-2.0 is disputed, or if later evidence shows a local font was modified in a way that triggers an additional naming or notice requirement.
