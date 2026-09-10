import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverPath = path.join(__dirname, "..", "server.js");

let source = fs.readFileSync(serverPath, "utf8");
let changed = false;

// TAKEOUT também precisa ser revalidado direto no iFood antes de bloquear.
// Isso corrige registros locais antigos ou incompletos que ficaram classificados errado.
const oldRefreshRule = `  const needsRefresh = !["DELIVERY","TAKEOUT"].includes(orderType) ||
    (orderType === "DELIVERY" && !["MERCHANT","IFOOD"].includes(deliveredBy));`;
const newRefreshRule = `  const needsRefresh = orderType !== "DELIVERY" ||
    !["MERCHANT","IFOOD"].includes(deliveredBy);`;

if (source.includes(oldRefreshRule)) {
  source = source.replace(oldRefreshRule, newRefreshRule);
  changed = true;
}

// Resolve displayId repetido priorizando a loja de produção configurada e pedidos recentes.
// Nunca mistura pedido de outro merchant e mantém bloqueio quando há ambiguidade real.
if (!source.includes("const configuredMerchantId = String(process.env.IFOOD_MERCHANT_ID")) {
  const selectionPattern = /    const candidates = grouped\.get\(key\) \|\| \[\];\n\n    \/\/ Não encontrado no iFood = pedido manual\. Mantém compatibilidade com outros canais\.\n    if \(!candidates\.length\) continue;\n\n    const current = candidates\.filter\(x => !ifoodOrderIsTerminal\(x\.status \|\| x\.last_event_code\)\);\n\n    if \(current\.length > 1\) \{[\s\S]*?\n    \}\n\n    let row = current\[0\] \|\| candidates\[0\];/;

  const replacement = `    const candidates = grouped.get(key) || [];

    // Não encontrado no iFood = pedido manual. Mantém compatibilidade com outros canais.
    if (!candidates.length) continue;

    const configuredMerchantId = String(process.env.IFOOD_MERCHANT_ID || "")
      .trim()
      .toLowerCase();

    let scopedCandidates = candidates;
    if (configuredMerchantId) {
      scopedCandidates = candidates.filter(x =>
        String(x.merchant_id || "").trim().toLowerCase() === configuredMerchantId
      );

      if (!scopedCandidates.length) {
        blocked.push({
          order_number: localOrder,
          code: "IFOOD_MERCHANT_MISMATCH",
          message: "Esse número foi encontrado no iFood, mas pertence a outra loja. Atualize e tente novamente."
        });
        continue;
      }
    }

    const candidateTimestamp = x => {
      const created = Date.parse(String(x.order_created_at || ""));
      const eventAt = Date.parse(String(x.last_event_at || ""));
      return Math.max(
        Number.isFinite(created) ? created : 0,
        Number.isFinite(eventAt) ? eventAt : 0
      );
    };

    const recentCutoff = Date.now() - (36 * 60 * 60 * 1000);
    const recentCandidates = scopedCandidates.filter(x => candidateTimestamp(x) >= recentCutoff);
    const selectionPool = (recentCandidates.length ? recentCandidates : scopedCandidates)
      .slice()
      .sort((a, b) => candidateTimestamp(b) - candidateTimestamp(a));

    const current = selectionPool.filter(x =>
      !ifoodOrderIsTerminal(x.status || x.last_event_code)
    );

    if (current.length > 1) {
      blocked.push({
        order_number: localOrder,
        code: "IFOOD_ORDER_AMBIGUOUS",
        message: "Há mais de um pedido iFood ativo com esse número nesta loja. Procure o administrador."
      });
      continue;
    }

    let row = current[0] || selectionPool[0];`;

  if (!selectionPattern.test(source)) {
    throw new Error("Bloco de seleção de pedidos iFood não encontrado; patch abortado para evitar alteração insegura.");
  }

  source = source.replace(selectionPattern, replacement);
  changed = true;
}

if (!source.includes("const configuredMerchantId = String(process.env.IFOOD_MERCHANT_ID")) {
  throw new Error("Filtro por merchant não foi aplicado.");
}

if (!source.includes('const needsRefresh = orderType !== "DELIVERY"')) {
  throw new Error("Revalidação de TAKEOUT não foi aplicada.");
}

if (changed) {
  fs.writeFileSync(serverPath, source, "utf8");
  console.log("iFood order resolution patch aplicado: merchant + recência + revalidação de TAKEOUT.");
} else {
  console.log("iFood order resolution patch já estava aplicado.");
}
