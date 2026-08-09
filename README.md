# Commandes automatiques + notification Telegram — Soumnelle Collection

Ce dossier contient un petit serveur qui, à chaque commande passée sur votre
site :

1. **l'enregistre dans une vraie base de données** (fichier `orders.db`) —
   vous gardez un historique complet, rien n'est jamais perdu ;
2. **vous envoie une notification instantanée sur Telegram** (application
   gratuite, comme WhatsApp mais sans compte professionnel ni vérification
   à faire).

La cliente clique sur **Confirmer** et voit uniquement le message
"Merci pour votre confiance ❤️" — elle ne voit jamais Telegram ni WhatsApp,
et la commande est toujours enregistrée même si la notification échoue.

Il y a 3 étapes : **A)** créer votre bot Telegram (2 minutes, aucune
vérification), **B)** déployer ce serveur, **C)** connecter le site à ce
serveur. Comptez 20-30 minutes au total.

---

## A. Configurer Telegram (aucun compte professionnel requis)

1. Installez l'application **Telegram** sur votre téléphone si vous ne
   l'avez pas déjà (gratuite, sur l'App Store / Play Store).
2. Dans Telegram, cherchez le compte **@BotFather** (c'est le bot officiel
   qui crée des bots) et ouvrez une conversation avec lui.
3. Envoyez-lui la commande `/newbot`, puis suivez ses instructions :
   - un nom pour votre bot (ex : `Soumnelle Commandes`)
   - un nom d'utilisateur qui doit finir par `bot` (ex : `SoumnelleCmdBot`)
4. BotFather vous renvoie un **token** du type
   `123456789:AAExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` → copiez-le, c'est votre
   `TELEGRAM_BOT_TOKEN`.
5. Cherchez maintenant **@userinfobot** dans Telegram, ouvrez une
   conversation et envoyez n'importe quel message : il vous répond avec
   votre **Id** (une suite de chiffres, parfois précédée d'un `-`) → c'est
   votre `TELEGRAM_CHAT_ID`.
6. Cherchez votre bot par le nom d'utilisateur que vous avez choisi à
   l'étape 3, ouvrez une conversation avec lui et envoyez-lui n'importe quel
   message (ex: "salut") — **obligatoire**, sinon le bot n'a pas le droit de
   vous écrire en premier.

C'est tout, pas de vérification d'entreprise, pas d'e-mail professionnel,
pas de délai d'approbation.

---

## B. Déployer le serveur (gratuit, sur Render.com)

1. Créez un compte sur [render.com](https://render.com) (gratuit).
2. Mettez ce dossier dans un dépôt GitHub (ou uploadez-le directement si
   Render vous le propose).
3. Sur Render : **New → Web Service** → connectez votre dépôt.
4. Réglages :
   - **Build command** : `npm install`
   - **Start command** : `npm start`
5. Dans l'onglet **Environment**, ajoutez les variables (mêmes noms que
   dans `.env.example`) :
   - `TELEGRAM_BOT_TOKEN` = le token donné par BotFather
   - `TELEGRAM_CHAT_ID` = l'identifiant donné par @userinfobot
   - `ALLOWED_ORIGIN` = l'adresse de votre site une fois en ligne (vous
     pouvez mettre `*` au début pour tester, puis restreindre ensuite)
   - `ADMIN_KEY` = un mot de passe de votre choix (pour consulter
     l'historique des commandes, voir section D)
6. Déployez. Render vous donne une adresse du type
   `https://soumnelle-order-notifier.onrender.com`.

*(Note : le plan gratuit de Render "s'endort" après 15 minutes d'inactivité
— le premier message après une pause peut prendre quelques secondes de plus
à partir. Si ce délai gêne, un plan payant à quelques dollars/mois le
supprime.)*

---

## C. Connecter le site à ce serveur

Dans `index.html`, tout en haut du `<script>`, changez :

```js
const BACKEND_URL = "https://soumnelle-order-notifier.onrender.com/api/order";
```

en mettant l'adresse Render obtenue à l'étape B (suivie de `/api/order`).

C'est tout : dès qu'une cliente clique sur **Confirmer**, la commande est
enregistrée et vous recevez un message Telegram, sans qu'elle ait quoi que
ce soit d'autre à faire — et sans qu'elle voie Telegram ou WhatsApp.

---

## Tester

1. Passez une commande test sur votre site.
2. Vous devez recevoir un message Telegram du type :
   > 🛍️ Nouvelle commande — Soumnelle Collection
   > 👤 Nom : ...
3. Si rien n'arrive, vérifiez dans les logs Render (onglet "Logs") le
   message d'erreur — la cause la plus fréquente est d'avoir oublié d'écrire
   au moins une fois au bot (étape A.6) ou une erreur dans le
   `TELEGRAM_CHAT_ID`. **La commande reste dans tous les cas enregistrée
   dans la base de données**, même si Telegram échoue.

---

## D. Consulter l'historique des commandes

1. Vérifiez que `ADMIN_KEY` est bien réglée sur Render (voir `.env.example`).
2. Ouvrez dans votre navigateur :
   `https://votre-serveur.onrender.com/admin/commandes?cle=VOTRE_MOT_DE_PASSE`
3. Vous voyez la liste de toutes les commandes (les plus récentes en haut),
   avec pour chacune : nom, téléphone, wilaya, livraison, articles, total,
   et si la notification Telegram a bien été envoyée ou non.

Gardez cette adresse et ce mot de passe privés — quiconque les connaît peut
voir les commandes de vos clientes.

---

## Règles de validation du formulaire (déjà en place)

- Tous les champs sont obligatoires (nom, téléphone, wilaya, mode de
  livraison, adresse si livraison à domicile).
- Le téléphone doit contenir **uniquement des chiffres**, **exactement 10**
  (ex : `0551234567`) — vérifié à la fois sur le site et sur le serveur, pour
  qu'aucune commande invalide ne puisse être enregistrée.

---

## ⚠️ Important : la persistance sur Render (plan gratuit)

Le plan gratuit de Render **efface le disque à chaque redéploiement** du
serveur (par exemple si vous modifiez le code et redéployez). Tant que vous
ne touchez pas au serveur, la base de données reste intacte — mais si vous
la redéployez, l'historique des anciennes commandes sera perdu.

Si vous voulez un historique qui survit à tous les redéploiements, deux
options simples :
- **Ajouter un "Disk" persistant sur Render** (quelques dollars/mois) et
  pointer `DB_PATH` vers ce disque (ex : `/data/orders.db`) — la solution la
  plus simple à garder telle quelle.
- Exporter/copier régulièrement le fichier `orders.db` avant tout
  redéploiement.

En attendant, la notification Telegram, elle, continue de fonctionner
normalement à chaque commande — seul l'historique en base est concerné.
