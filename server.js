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
app.use(express.urlencoded({ extended: true })); // pour le formulaire de la page /admin/stock

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
    items_json TEXT,
    telegram_status TEXT NOT NULL DEFAULT 'en_attente',
    telegram_error TEXT
  )
`);

const insertOrder = db.prepare(`
  INSERT INTO orders (created_at, nom, telephone, wilaya, livraison, articles, total, items_json, telegram_status)
  VALUES (@created_at, @nom, @telephone, @wilaya, @livraison, @articles, @total, @items_json, 'en_attente')
`);

const updateOrderStatus = db.prepare(`
  UPDATE orders SET telegram_status = ?, telegram_error = ? WHERE id = ?
`);

const listOrders = db.prepare(`
  SELECT * FROM orders ORDER BY id DESC LIMIT 500
`);

/* ===================== Stock ===================== */
// Le stock est géré ici, côté serveur, pour qu'il soit fiable même si
// plusieurs clientes commandent en même temps (jamais deux clientes ne
// peuvent acheter la dernière pièce en même temps).

db.exec(`
  CREATE TABLE IF NOT EXISTS stock (
    product_id TEXT NOT NULL,
    color TEXT NOT NULL,
    size TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    PRIMARY KEY (product_id, color, size)
  )
`);

// Quantités de départ. Ces lignes ne sont ajoutées que si elles n'existent
// pas déjà (INSERT OR IGNORE) — donc si vous relancez le serveur, les
// quantités déjà vendues ne sont pas réinitialisées... SAUF si le disque
// Render a été effacé par un redéploiement (voir README, persistance).
const INITIAL_STOCK = [
  // Ensemble Brise
  ["ensemble-brise", "Bleu ciel", "S", 0],
  ["ensemble-brise", "Bleu ciel", "M", 1],
  ["ensemble-brise", "Bleu ciel", "L", 0],
  ["ensemble-brise", "Bleu ciel", "XL", 0],
  ["ensemble-brise", "Beige", "S", 0],
  ["ensemble-brise", "Beige", "M", 0],
  ["ensemble-brise", "Beige", "L", 0],
  ["ensemble-brise", "Beige", "XL", 0],
];
["Vert", "Bleu", "Blanc", "Marron", "Noir", "Beige"].forEach((color) => {
  ["36", "38", "40", "42", "44"].forEach((size) => {
    INITIAL_STOCK.push(["ensemble-samer", color, size, 2]);
  });
});

// Robe Victoria — tailles S/M/L, couleurs Beige et Brique
["Beige", "Brique"].forEach((color) => {
  ["S", "M", "L"].forEach((size) => {
    INITIAL_STOCK.push(["robe-victoria", color, size, 0]);
  });
});

// Robe d'Hôtesse — taille unique, couleurs Violet et Bleu
["Violet", "Bleu"].forEach((color) => {
  INITIAL_STOCK.push(["robe-hotesse", color, "Taille unique", 0]);
});

// Abaya Élégance — tailles groupées S/M et L/XL, couleurs Marron et Rose
["Marron", "Rose"].forEach((color) => {
  ["S/M", "L/XL"].forEach((size) => {
    INITIAL_STOCK.push(["abaya-elegance", color, size, 0]);
  });
});

// Veste en Similicuir Bomber — tailles S/M/L/XL, couleurs Bordeaux/Noir/Marron
["Bordeaux", "Noir", "Marron"].forEach((color) => {
  ["S", "M", "L", "XL"].forEach((size) => {
    INITIAL_STOCK.push(["veste-bomber", color, size, 0]);
  });
});

const seedStockRow = db.prepare(`
  INSERT OR IGNORE INTO stock (product_id, color, size, quantity) VALUES (?, ?, ?, ?)
`);
const seedStock = db.transaction((rows) => {
  rows.forEach((r) => seedStockRow.run(...r));
});
seedStock(INITIAL_STOCK);

const getStockRow = db.prepare(
  `SELECT quantity FROM stock WHERE product_id = ? AND color = ? AND size = ?`
);
const decrementStockRow = db.prepare(
  `UPDATE stock SET quantity = quantity - ? WHERE product_id = ? AND color = ? AND size = ?`
);
const setStockRow = db.prepare(
  `UPDATE stock SET quantity = ? WHERE product_id = ? AND color = ? AND size = ?`
);
const listStock = db.prepare(`SELECT product_id, color, size, quantity FROM stock ORDER BY product_id, color, size`);

/* ===================== Routes ===================== */

app.get("/", (req, res) => {
  res.send("Soumnelle Collection — serveur de commandes actif.");
});

/**
 * GET /api/stock
 * Renvoie les quantités restantes pour chaque produit/couleur/taille.
 * Le site l'utilise pour griser automatiquement les couleurs/tailles
 * épuisées, sans avoir à modifier le code du site à chaque vente.
 */
app.get("/api/stock", (req, res) => {
  res.json({ ok: true, stock: listStock.all() });
});

/**
 * POST /api/order
 * 1) Enregistre la commande en base de données.
 * 2) Essaie de l'envoyer sur WhatsApp via un modèle ("template") approuvé
 *    par Meta. Si l'envoi échoue, la commande reste quand même enregistrée
 *    (visible sur /admin/commandes) — rien n'est perdu.
 */
app.post("/api/order", async (req, res) => {
  const { nom, telephone, wilaya, livraison, articles, total, items } = req.body || {};

  if (!nom || !telephone || !wilaya || !livraison || !articles || !total || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ ok: false, error: "Données de commande incomplètes : tous les champs sont obligatoires." });
  }

  // Le numéro de téléphone doit être composé uniquement de chiffres,
  // exactement 10 (ex: 0551234567). Revérifié ici côté serveur même s'il
  // l'est déjà côté site, pour ne jamais enregistrer une commande invalide.
  if (!/^[0-9]{10}$/.test(String(telephone).trim())) {
    return res.status(400).json({ ok: false, error: "Le numéro de téléphone doit contenir exactement 10 chiffres." });
  }

  // 0) Vérifier ET réserver le stock en une seule transaction "tout ou
  //    rien" : si un seul article de la commande n'a plus assez de stock,
  //    toute la commande est refusée (rien n'est décrémenté) — ça évite
  //    qu'une pièce soit vendue deux fois si deux clientes commandent au
  //    même moment.
  let stockConflict = null;
  const reserveStock = db.transaction(() => {
    for (const item of items) {
      const row = getStockRow.get(item.product_id, item.color, item.size);
      const available = row ? row.quantity : null;
      if (available === null) continue; // article non suivi en stock : on laisse passer
      if (available < item.qty) {
        stockConflict = { product_id: item.product_id, color: item.color, size: item.size, available };
        throw new Error("STOCK_INSUFFISANT");
      }
    }
    for (const item of items) {
      const row = getStockRow.get(item.product_id, item.color, item.size);
      if (row === undefined) continue;
      decrementStockRow.run(item.qty, item.product_id, item.color, item.size);
    }
  });

  try {
    reserveStock();
  } catch (err) {
    if (stockConflict) {
      return res.status(409).json({
        ok: false,
        error: "stock_insuffisant",
        detail: stockConflict,
      });
    }
    console.error("Erreur stock:", err);
    return res.status(500).json({ ok: false, error: "Erreur serveur lors de la vérification du stock." });
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
    items_json: JSON.stringify(items),
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
        nav{margin-bottom:16px;font-size:.9rem;}
        nav a{color:#8A5A3B;text-decoration:none;}
        nav a:hover{text-decoration:underline;}
      </style>
    </head>
    <body>
      <h1>Commandes — Soumnelle Collection (${orders.length})</h1>
      <nav><a href="/admin/stock?cle=${encodeURIComponent(req.query.cle)}">Gérer le stock →</a></nav>
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

/**
 * GET /admin/stock?cle=VOTRE_CLE
 * Page qui permet de modifier les quantités en stock (par produit, couleur,
 * taille) sans toucher au code ni redéployer. Protégée par la même clé
 * ADMIN_KEY que la page des commandes.
 */
app.get("/admin/stock", (req, res) => {
  if (!ADMIN_KEY) {
    return res
      .status(500)
      .send("ADMIN_KEY n'est pas configurée sur le serveur. Ajoutez-la dans les variables d'environnement.");
  }
  if (req.query.cle !== ADMIN_KEY) {
    return res.status(403).send("Accès refusé : clé manquante ou incorrecte (?cle=...)");
  }

  const rows = listStock.all();
  const cle = encodeURIComponent(req.query.cle);

  // On regroupe les lignes par produit pour un affichage plus lisible.
  const byProduct = {};
  rows.forEach((r) => {
    if (!byProduct[r.product_id]) byProduct[r.product_id] = [];
    byProduct[r.product_id].push(r);
  });

  const productLabels = {
    "ensemble-brise": "Ensemble Brise",
    "ensemble-samer": "Ensemble Samer",
    "robe-victoria": "Robe Victoria",
    "robe-hotesse": "Robe d'Hôtesse",
    "abaya-elegance": "Abaya Élégance",
    "veste-bomber": "Veste en Similicuir Bomber",
  };

  const sections = Object.entries(byProduct)
    .map(([productId, items]) => {
      const cellsByColor = {};
      items.forEach((it) => {
        if (!cellsByColor[it.color]) cellsByColor[it.color] = [];
        cellsByColor[it.color].push(it);
      });

      const colorBlocks = Object.entries(cellsByColor)
        .map(
          ([color, sizes]) => `
        <div class="color-block">
          <h3>${escapeHtml(color)}</h3>
          <div class="sizes">
            ${sizes
              .map(
                (s) => `
              <label class="size-field ${s.quantity <= 0 ? "empty" : ""}">
                <span>${escapeHtml(s.size)}</span>
                <input
                  type="number"
                  min="0"
                  name="qty__${encodeURIComponent(s.product_id)}__${encodeURIComponent(s.color)}__${encodeURIComponent(s.size)}"
                  value="${s.quantity}"
                />
              </label>`
              )
              .join("")}
          </div>
        </div>`
        )
        .join("");

      return `
        <section class="product">
          <h2>${escapeHtml(productLabels[productId] || productId)}</h2>
          <div class="colors">${colorBlocks}</div>
        </section>`;
    })
    .join("");

  res.send(`
    <!DOCTYPE html>
    <html lang="fr">
    <head>
      <meta charset="UTF-8">
      <title>Gestion du stock — Soumnelle Collection</title>
      <style>
        body{font-family:sans-serif;padding:24px;background:#F6F1E9;color:#352C24;max-width:900px;margin:0 auto;}
        h1{font-size:1.4rem;margin-bottom:4px;}
        nav{margin-bottom:20px;font-size:.9rem;}
        nav a{color:#8A5A3B;text-decoration:none;}
        nav a:hover{text-decoration:underline;}
        p.hint{font-size:.85rem;color:#6b5f52;margin-top:0;}
        .product{background:#fff;border:1px solid #E1D5C2;border-radius:10px;padding:16px 20px;margin-bottom:18px;}
        .product h2{margin:0 0 12px;font-size:1.1rem;}
        .colors{display:flex;flex-wrap:wrap;gap:18px;}
        .color-block h3{margin:0 0 8px;font-size:.9rem;color:#6b5f52;}
        .sizes{display:flex;flex-wrap:wrap;gap:8px;}
        .size-field{display:flex;flex-direction:column;align-items:center;gap:4px;font-size:.75rem;color:#6b5f52;}
        .size-field input{width:56px;padding:5px;border:1px solid #E1D5C2;border-radius:6px;text-align:center;font-size:.9rem;}
        .size-field.empty input{border-color:#d98a8a;background:#FDF3F3;}
        .actions{position:sticky;bottom:0;background:#F6F1E9;padding:16px 0;}
        button{background:#8A5A3B;color:#fff;border:none;padding:12px 22px;border-radius:8px;font-size:.95rem;cursor:pointer;}
        button:hover{background:#734a30;}
        .saved{color:#2e7d32;font-size:.9rem;margin-bottom:14px;}
      </style>
    </head>
    <body>
      <h1>Gestion du stock — Soumnelle Collection</h1>
      <p class="hint">Modifiez les quantités puis cliquez sur « Enregistrer ». Une taille à 0 s'affichera « Fin de stock » sur le site.</p>
      <nav><a href="/admin/commandes?cle=${cle}">← Voir les commandes</a></nav>
      ${req.query.enregistre === "1" ? '<p class="saved">✅ Stock mis à jour.</p>' : ""}
      <form method="POST" action="/admin/stock?cle=${cle}">
        ${sections}
        <div class="actions">
          <button type="submit">Enregistrer les modifications</button>
        </div>
      </form>
    </body>
    </html>
  `);
});

/**
 * POST /admin/stock?cle=VOTRE_CLE
 * Traite le formulaire ci-dessus : met à jour toutes les quantités envoyées.
 */
app.post("/admin/stock", (req, res) => {
  if (!ADMIN_KEY) {
    return res
      .status(500)
      .send("ADMIN_KEY n'est pas configurée sur le serveur. Ajoutez-la dans les variables d'environnement.");
  }
  if (req.query.cle !== ADMIN_KEY) {
    return res.status(403).send("Accès refusé : clé manquante ou incorrecte (?cle=...)");
  }

  const updates = [];
  for (const [key, value] of Object.entries(req.body || {})) {
    if (!key.startsWith("qty__")) continue;
    const [, productId, color, size] = key.split("__").map(decodeURIComponent);
    const qty = Math.max(0, parseInt(value, 10) || 0);
    updates.push([qty, productId, color, size]);
  }

  const applyUpdates = db.transaction((rows) => {
    rows.forEach((r) => setStockRow.run(...r));
  });
  applyUpdates(updates);

  res.redirect(`/admin/stock?cle=${encodeURIComponent(req.query.cle)}&enregistre=1`);
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
