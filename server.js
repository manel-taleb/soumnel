/**
 * Soumnelle Collection — serveur de commandes
 * ------------------------------------------------------------
 * Ce serveur reçoit chaque commande envoyée par le site (index.html) et fait
 * DEUX choses, dans cet ordre :
 *
 *   1) Il ENREGISTRE la commande dans une vraie base de données (fichier
 *      SQLite "orders.db") — rien n'est jamais perdu, même si l'envoi
 *      Telegram échoue.
 *   2) Il ENVOIE une notification automatique sur Telegram (message
 *      instantané), via un bot Telegram — pas besoin de compte
 *      professionnel, pas de vérification, pas d'e-mail à fournir.
 *
 * Vous pouvez consulter l'historique des commandes à tout moment sur :
 *   https://votre-serveur.onrender.com/admin/commandes?cle=VOTRE_CLE
 * (la clé est définie par vous dans ADMIN_KEY, voir .env.example)
 *
 * Variables d'environnement nécessaires (voir .env.example) :
 *   TELEGRAM_BOT_TOKEN    -> jeton du bot, donné par @BotFather sur Telegram
 *   TELEGRAM_CHAT_ID      -> identifiant de la conversation qui doit recevoir
 *                            les commandes (voir README, section Telegram)
 *   ALLOWED_ORIGIN        -> URL de votre site (pour la sécurité CORS),
 *                            ex: https://soumnellecollection.netlify.app
 *   ADMIN_KEY             -> mot de passe simple pour consulter /admin/commandes
 *   DB_PATH               -> chemin du fichier base de données
 *                            (par défaut: ./orders.db — voir note sur Render
 *                            dans le README au sujet de la persistance)
 *   PORT                  -> port d'écoute (Render le fournit automatiquement)
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Database = require("better-sqlite3");
const path = require("path");

const app = express();
app.use(express.json());

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
app.use(cors({ origin: ALLOWED_ORIGIN }));

const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  ADMIN_KEY,
  DB_PATH = path.join(__dirname, "orders.db"),
  PORT = 3000,
} = process.env;

/* ===================== Base de données ===================== */

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    nom TEXT NOT NULL,
    telephone TEXT NOT NULL,
    wilaya TEXT NOT NULL,
    livraison TEXT NOT NULL,
    articles TEXT NOT NULL,
    total TEXT NOT NULL,
    telegram_status TEXT NOT NULL DEFAULT 'en_attente',
    telegram_error TEXT
  )
`);

const insertOrder = db.prepare(`
  INSERT INTO orders (created_at, nom, telephone, wilaya, livraison, articles, total, telegram_status)
  VALUES (@created_at, @nom, @telephone, @wilaya, @livraison, @articles, @total, 'en_attente')
`);

const updateOrderStatus = db.prepare(`
  UPDATE orders SET telegram_status = ?, telegram_error = ? WHERE id = ?
`);

const listOrders = db.prepare(`
  SELECT * FROM orders ORDER BY id DESC LIMIT 500
`);

/* ===================== Routes ===================== */

app.get("/", (req, res) => {
  res.send("Soumnelle Collection — serveur de commandes actif.");
});

/**
 * POST /api/order
 * 1) Enregistre la commande en base de données.
 * 2) Essaie de l'envoyer sur WhatsApp via un modèle ("template") approuvé
 *    par Meta. Si l'envoi échoue, la commande reste quand même enregistrée
 *    (visible sur /admin/commandes) — rien n'est perdu.
 */
app.post("/api/order", async (req, res) => {
  const { nom, telephone, wilaya, livraison, articles, total } = req.body || {};

  if (!nom || !telephone || !wilaya || !livraison || !articles || !total) {
    return res.status(400).json({ ok: false, error: "Données de commande incomplètes : tous les champs sont obligatoires." });
  }

  // Le numéro de téléphone doit être composé uniquement de chiffres,
  // exactement 10 (ex: 0551234567). Revérifié ici côté serveur même s'il
  // l'est déjà côté site, pour ne jamais enregistrer une commande invalide.
  if (!/^[0-9]{10}$/.test(String(telephone).trim())) {
    return res.status(400).json({ ok: false, error: "Le numéro de téléphone doit contenir exactement 10 chiffres." });
  }

  // 1) Toujours enregistrer d'abord, quoi qu'il arrive avec Telegram ensuite.
  const info = insertOrder.run({
    created_at: new Date().toISOString(),
    nom: String(nom),
    telephone: String(telephone),
    wilaya: String(wilaya),
    livraison: String(livraison),
    articles: String(articles),
    total: String(total),
  });
  const orderId = info.lastInsertRowid;

  // 2) Si Telegram n'est pas configuré, on répond quand même "ok" : la
  //    commande est bien enregistrée, seule la notification manque.
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    updateOrderStatus.run("non_configure", "TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID manquant(s)", orderId);
    return res.json({ ok: true, orderId, telegram: "non_configure" });
  }

  const message = [
    "🛍️ Nouvelle commande — Soumnelle Collection",
    "",
    `👤 Nom : ${nom}`,
    `📞 Téléphone : ${telephone}`,
    `📍 Wilaya : ${wilaya}`,
    `🚚 Livraison : ${livraison}`,
    `🧾 Articles : ${articles}`,
    `💰 Total : ${total}`,
  ].join("\n");

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message }),
      }
    );

    const data = await response.json();

    if (!response.ok || data.ok === false) {
      console.error("Erreur API Telegram:", data);
      updateOrderStatus.run("echec", JSON.stringify(data), orderId);
      // La commande est quand même enregistrée : on renvoie "ok" au site
      // pour que la cliente voie le message de remerciement, mais on
      // signale l'échec Telegram pour que vous puissiez la retrouver
      // dans /admin/commandes.
      return res.json({ ok: true, orderId, telegram: "echec" });
    }

    updateOrderStatus.run("envoye", null, orderId);
    return res.json({ ok: true, orderId, telegram: "envoye" });
  } catch (err) {
    console.error("Erreur serveur:", err);
    updateOrderStatus.run("echec", String(err), orderId);
    return res.json({ ok: true, orderId, telegram: "echec" });
  }
});

/**
 * GET /admin/commandes?cle=VOTRE_CLE
 * Page simple listant toutes les commandes enregistrées, les plus
 * récentes en premier. Protégée par la clé ADMIN_KEY.
 */
app.get("/admin/commandes", (req, res) => {
  if (!ADMIN_KEY) {
    return res
      .status(500)
      .send("ADMIN_KEY n'est pas configurée sur le serveur. Ajoutez-la dans les variables d'environnement.");
  }
  if (req.query.cle !== ADMIN_KEY) {
    return res.status(403).send("Accès refusé : clé manquante ou incorrecte (?cle=...)");
  }

  const orders = listOrders.all();

  const statusLabel = {
    envoye: "✅ Envoyé sur Telegram",
    echec: "⚠️ Échec Telegram (voir détail)",
    non_configure: "⚠️ Telegram non configuré",
    en_attente: "⏳ En cours",
  };

  const rows = orders
    .map(
      (o) => `
    <tr>
      <td>${o.id}</td>
      <td>${new Date(o.created_at).toLocaleString("fr-FR")}</td>
      <td>${escapeHtml(o.nom)}</td>
      <td>${escapeHtml(o.telephone)}</td>
      <td>${escapeHtml(o.wilaya)}</td>
      <td>${escapeHtml(o.livraison)}</td>
      <td>${escapeHtml(o.articles)}</td>
      <td>${escapeHtml(o.total)}</td>
      <td title="${escapeHtml(o.telegram_error || "")}">${statusLabel[o.telegram_status] || o.telegram_status}</td>
    </tr>`
    )
    .join("");

  res.send(`
    <!DOCTYPE html>
    <html lang="fr">
    <head>
      <meta charset="UTF-8">
      <title>Commandes — Soumnelle Collection</title>
      <style>
        body{font-family:sans-serif;padding:24px;background:#F6F1E9;color:#352C24;}
        h1{font-size:1.4rem;}
        table{border-collapse:collapse;width:100%;background:#fff;font-size:.85rem;}
        th,td{border:1px solid #E1D5C2;padding:8px 10px;text-align:left;vertical-align:top;}
        th{background:#EFE7D9;}
        tr:hover{background:#FFFDF9;}
      </style>
    </head>
    <body>
      <h1>Commandes — Soumnelle Collection (${orders.length})</h1>
      <table>
        <thead>
          <tr>
            <th>#</th><th>Date</th><th>Nom</th><th>Téléphone</th><th>Wilaya</th>
            <th>Livraison</th><th>Articles</th><th>Total</th><th>Telegram</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </body>
    </html>
  `);
});

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

app.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT} — base de données : ${DB_PATH}`);
});
