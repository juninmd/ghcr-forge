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

export function setYamlValue(yaml: string, path: string[], value: string): string {
  if (!path.length) throw new Error("caminho vazio");
  const lines = yaml.split("\n");
  const ancestors: number[] = [];
  let depth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = KEY_LINE.exec(line);
    if (!m) continue;
    const indent = (m[1] ?? "").length;
    const key = m[2] ?? "";

    // Recuou até o nível de um ancestral: saímos do bloco dele.
    while (depth > 0 && indent <= (ancestors[depth - 1] ?? -1)) {
      ancestors.pop();
      depth--;
    }

    if (key !== path[depth]) continue;

    if (depth === path.length - 1) {
      const trailing = /(\s+#.*)$/.exec(m[3] ?? "")?.[1] ?? "";
      lines[i] = `${m[1]}${key}: ${quoteScalar(value)}${trailing}`;
      return lines.join("\n");
    }

    ancestors.push(indent);
    depth++;
  }

  throw new Error(`chave "${path.join(".")}" não encontrada no values.yaml`);
}

/** Lê o valor atual de uma chave — usado para não commitar quando nada mudou. */
export function getYamlValue(yaml: string, path: string[]): string | null {
  const lines = yaml.split("\n");
  const ancestors: number[] = [];
  let depth = 0;

  for (const line of lines) {
    const m = KEY_LINE.exec(line);
    if (!m) continue;
    const indent = (m[1] ?? "").length;
    const key = m[2] ?? "";

    while (depth > 0 && indent <= (ancestors[depth - 1] ?? -1)) {
      ancestors.pop();
      depth--;
    }

    if (key !== path[depth]) continue;

    if (depth === path.length - 1) {
      const raw = (m[3] ?? "").replace(/\s+#.*$/, "").trim();
      return raw.replace(/^["']|["']$/g, "");
    }

    ancestors.push(indent);
    depth++;
  }
  return null;
}
