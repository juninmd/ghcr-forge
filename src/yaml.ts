/**
 * Edição cirúrgica de um values.yaml: troca UM valor escalar, preservando
 * comentários, ordem e formatação do resto do arquivo.
 *
 * Fazemos isso na mão de propósito — parse+dump de YAML reescreve o arquivo
 * inteiro e produz um diff impossível de revisar em um repo de GitOps.
 */

const KEY_LINE = /^(\s*)([\w.\-]+):(.*)$/;

/** Valor sempre entre aspas: tag como `1.2` ou `true` não pode virar número/bool. */
export function quoteScalar(value: string): string {
  return JSON.stringify(value);
}

/**
 * Acha a linha da chave `path`. Em cada nível só vale um filho direto do
 * ancestral (a indentação do primeiro filho do bloco): `backend.image.tag` não
 * pode casar com `backend.sidecar.image.tag`, que está mais fundo.
 */
function findKey(lines: string[], path: string[]): { index: number; match: RegExpExecArray } | null {
  // Para cada nível já casado: indentação da chave e indentação dos seus filhos diretos.
  const ancestors: { indent: number; child: number | null }[] = [];
  let root: number | null = null;

  for (let i = 0; i < lines.length; i++) {
    const m = KEY_LINE.exec(lines[i] ?? "");
    if (!m) continue;
    const indent = (m[1] ?? "").length;

    // Recuou até o nível de um ancestral: saímos do bloco dele.
    while (ancestors.length && indent <= (ancestors.at(-1)?.indent ?? -1)) ancestors.pop();

    const parent = ancestors.at(-1);
    if (parent) {
      parent.child ??= indent;
      if (indent !== parent.child) continue;
    } else {
      root ??= indent;
      if (indent !== root) continue;
    }

    if ((m[2] ?? "") !== path[ancestors.length]) continue;
    if (ancestors.length === path.length - 1) return { index: i, match: m };
    ancestors.push({ indent, child: null });
  }
  return null;
}

export function setYamlValue(yaml: string, path: string[], value: string): string {
  if (!path.length) throw new Error("caminho vazio");
  const lines = yaml.split("\n");
  const found = findKey(lines, path);
  if (!found) throw new Error(`chave "${path.join(".")}" não encontrada no values.yaml`);
  const { index, match: m } = found;
  const trailing = /(\s+#.*)$/.exec(m[3] ?? "")?.[1] ?? "";
  lines[index] = `${m[1]}${m[2]}: ${quoteScalar(value)}${trailing}`;
  return lines.join("\n");
}

/** Lê o valor atual de uma chave — usado para não commitar quando nada mudou. */
export function getYamlValue(yaml: string, path: string[]): string | null {
  if (!path.length) return null;
  const found = findKey(yaml.split("\n"), path);
  if (!found) return null;
  const raw = (found.match[3] ?? "").replace(/\s+#.*$/, "").trim();
  return raw.replace(/^["']|["']$/g, "");
}
