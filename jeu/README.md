# Île isométrique — base de jeu

Base de jeu 3D isométrique (Three.js, sans étape de build) : ouvrir `jeu/index.html` via un serveur
(ex. `python3 -m http.server` puis http://localhost:8000/jeu/) ou GitHub Pages.

- **Grille stricte** : le personnage se déplace case par case (flèches / ZQSD, ou clic avec recherche de chemin ; la caméra reste alors fixe, `F` ou les flèches la recentrent). `G` affiche ou masque la grille.
- **Arbres** : `Maj`+clic lance une graine sur la case visée (dans l'eau, elle coule). `Espace` (ou « Planter ») sème une graine devant le personnage. Elle devient pousse, jeune arbre puis arbre, qui fleurit une fois adulte (≈ 90 s, en temps réel : la croissance continue jeu fermé). Les arbres bloquent le passage ; survoler ou cliquer un arbre affiche son stade.
- **Forêt vivante** : un arbre adulte entouré d'au moins 6 arbres adultes (sur 8 voisins) devient **majestueux** — plus grand, couronne lumineuse, lanternes suspendues, racines, aura dorée (6 rondins) ; ils restent espacés, au cœur des bois. Des **buissons** apparaissent peu à peu en lisière, au pied des arbres adultes, aux couleurs des arbres voisins ; ils grandissent, fleurissent et se traversent.
- **Éditeur** (`Tab`) : pinceaux Herbe, Terre, Eau (qui effacent les arbres), Arbre (adulte) et placement du personnage, tailles 1/3/5, annuler, carte vide/aléatoire, export/import JSON. La carte est sauvegardée automatiquement dans le navigateur.
- **Tuiles connectées** : le maillage du terrain est recalculé selon les voisins de chaque case — falaises de terre (avec liseré d'herbe) face à l'eau, coins extérieurs arrondis, fondu herbe/terre entre cases, écume le long des rives.
- **Rendu éthéré** : herbe procédurale (nuances, fleurs) et brins animés par le vent qui s'écartent au passage du personnage ; eau en shader (profondeur, reflets, éclats, écume animée, caustiques sur le fond) ; ciel d'aube pastel, poussières de lumière et halo lumineux (bloom).
- Caméra : `E`/`R` pivoter de 90°, molette pour zoomer, clic droit pour déplacer la vue en mode édition.

## Code

- `js/map.js` — données de la grille, chemin (BFS), génération aléatoire, (dé)sérialisation.
- `js/terrain.js` — construction du maillage connecté et de l'eau animée.
- `js/grass.js` — brins d'herbe instanciés (vent, interaction).
- `js/motes.js` — poussières de lumière flottantes.
- `js/noise.glsl.js` — bruit GLSL partagé.
- `js/trees.js` — arbres et leur croissance.
- `js/seeds.js` — graines lancées en cloche.
- `js/sparkles.js` — gerbes d'étincelles.
- `js/ecology.js` — règles de la forêt (arbres majestueux, buissons de lisière).
- `js/bushes.js` — buissons.
- `js/character.js` — personnage et déplacement case par case.
- `js/main.js` — scène, caméra isométrique, entrées, éditeur et interface.
