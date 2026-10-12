/Users/pablo/Projects/SpainAssistant/feedback/Screenshot\ 2026-10-06\ at\ 14.02.15.png
/Users/pablo/Projects/SpainAssistant/feedback/Screenshot\ 2026-10-06\ at\ 14.02.28.png

Should use scrollbar gutter stable both edges to ensure the scrollbar doesn't move cards

/Users/pablo/Projects/SpainAssistant/feedback/Screenshot\ 2026-10-06\ at\ 14.04.27.png

Remove text, move button inside empty state (when empty), just like Datos Personales

Remove the Privacidad tab altogether (redundant with the info above)

/Users/pablo/Projects/SpainAssistant/feedback/Screenshot\ 2026-10-06\ at\ 14.07.09.png

Remove the OS/platform
Remove the bottom text
Remove the card + title + icon, keep it "naked" on the background

/Users/pablo/Projects/SpainAssistant/feedback/Screenshot\ 2026-10-06\ at\ 14.08.43.png

Is N Seguridad Social a thing in Spain? Do you have a dedicated number? And do some procedures acutally ask for it? (Just asking, I'm not sure)

/Users/pablo/Projects/SpainAssistant/feedback/Screenshot\ 2026-10-06\ at\ 14.10.25.png

Let's correctly localize the possible errors. And instead of the awkward "Problem: Problem Description" let's just say it plainly. For example, here it should be "No hay conexión a internet"

/Users/pablo/Projects/SpainAssistant/feedback/Screenshot\ 2026-10-06\ at\ 14.11.46.png

Remove "De Mis datos"

When nothing is in Mis Datos, just open the file picker directly, skip the modal


Implementation notes (2026-10-06):

- Mis datos and Ajustes now use `scrollbar-gutter: stable both-edges`.
- The document intro text is removed. The upload button is inside the empty state.
- The Privacy tab is removed. Delete all data is in Settings. The storage warning stays visible when secure storage is unavailable.
- About shows the brand, development badge and version directly on the background.
- Agent errors use Spanish or English messages. Connection errors show “No hay conexión a internet.” Timeouts, unavailable services and long conversations have separate messages. Unknown failures show a local message without raw provider text.
- The attachment menu has no “De Mis datos” heading. With no saved documents, the button opens the file picker directly.
- The Social Security number field stays. Spain has a personal NUSS. It is also called NAF when the person starts work. It is used for work registration and benefits. See [Seguridad Social: request a number](https://portal.seg-social.gob.es/wps/wcm/connect/importass/importass_contenidos/categorias/altas%2C%2Bbajas%2By%2Bmodificaciones/altas%2By%2Bafiliacion%2Bde%2Btrabajadores/solicitar%2Bel%2Bnumero%2Bde%2Bla%2Bseguridad%2Bsocial).
