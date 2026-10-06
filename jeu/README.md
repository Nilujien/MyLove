# Île isométrique — base de jeu

Base de jeu 3D isométrique (Three.js, sans étape de build) : ouvrir `jeu/index.html` via un serveur
(ex. `python3 -m http.server` puis http://localhost:8000/jeu/) ou GitHub Pages.

- **Grille stricte** : le personnage se déplace case par case (flèches / ZQSD, ou clic avec recherche de chemin).
- **Éditeur** (`Tab`) : pinceaux Herbe, Terre, Eau et placement du personnage, tailles 1/3/5, annuler, carte vide/aléatoire, export/import JSON. La carte est sauvegardée automatiquement dans le navigateur.
- **Tuiles connectées** : le maillage du terrain est recalculé selon les voisins de chaque case — falaises de terre (avec liseré d'herbe) face à l'eau, coins extérieurs arrondis, fondu herbe/terre entre cases, écume le long des rives.
- **Rendu éthéré** : herbe procédurale (nuances, fleurs) et brins animés par le vent qui s'écartent au passage du personnage ; eau en shader (profondeur, reflets, éclats, écume animée, caustiques sur le fond) ; ciel d'aube pastel, poussières de lumière et halo lumineux (bloom).
- Caméra : `E`/`R` pivoter de 90°, molette pour zoomer, clic droit pour déplacer la vue en mode édition.

## Code

- `js/map.js` — données de la grille, chemin (BFS), génération aléatoire, (dé)sérialisation.
- `js/terrain.js` — construction du maillage connecté et de l'eau animée.
- `js/grass.js` — brins d'herbe instanciés (vent, interaction).
- `js/motes.js` — poussières de lumière flottantes.
- `js/noise.glsl.js` — bruit GLSL partagé.
- `js/character.js` — personnage et déplacement case par case.
- `js/main.js` — scène, caméra isométrique, entrées, éditeur et interface.
