import { describe, expect, test } from "bun:test";
import { getYamlValue, setYamlValue } from "../src/yaml.ts";

const VALUES = `# values do app
replicaCount: 1

image:
  repository: ghcr.io/juninmd/app
  tag: "sha-000000000000"   # gerenciado pelo ghcr-forge
  pullPolicy: IfNotPresent

resources:
  limits:
    memory: 256Mi

ingress:
  enabled: true
  tag: "isso-nao-e-a-imagem"
`;

describe("setYamlValue", () => {
  test("troca a chave aninhada certa", () => {
    const out = setYamlValue(VALUES, ["image", "tag"], "sha-abc123def456");
    expect(out).toContain('tag: "sha-abc123def456"');
    expect(out).toContain('tag: "isso-nao-e-a-imagem"');
  });

  test("não encosta em chave de mesmo nome em outro bloco", () => {
    const out = setYamlValue(VALUES, ["ingress", "tag"], "novo");
    expect(out).toContain('tag: "sha-000000000000"');
    expect(out).toContain('tag: "novo"');
  });

  test("preserva o resto do arquivo linha a linha", () => {
    const out = setYamlValue(VALUES, ["image", "tag"], "sha-abc123def456");
    expect(out.split("\n").length).toBe(VALUES.split("\n").length);
    expect(out).toContain("# values do app");
    expect(out).toContain("  repository: ghcr.io/juninmd/app");
  });

  test("preserva o comentário de fim de linha", () => {
    const out = setYamlValue(VALUES, ["image", "tag"], "sha-novo");
    expect(out).toContain("# gerenciado pelo ghcr-forge");
  });

  test("preserva a indentação original", () => {
    const out = setYamlValue(VALUES, ["resources", "limits", "memory"], "512Mi");
    expect(out).toContain('    memory: "512Mi"');
  });

  test("sempre entre aspas: tag numérica não vira número", () => {
    const out = setYamlValue(VALUES, ["image", "tag"], "1.20");
    expect(out).toContain('tag: "1.20"');
  });

  test("chave inexistente falha alto em vez de gravar errado", () => {
    expect(() => setYamlValue(VALUES, ["image", "digest"], "x")).toThrow("não encontrada");
    expect(() => setYamlValue(VALUES, ["nao", "existe"], "x")).toThrow();
  });

  test("caminho vazio é erro", () => {
    expect(() => setYamlValue(VALUES, [], "x")).toThrow("caminho vazio");
  });

  test("chave de topo também funciona", () => {
    expect(setYamlValue(VALUES, ["replicaCount"], "3")).toContain('replicaCount: "3"');
  });
});

describe("getYamlValue", () => {
  test("lê o valor atual sem as aspas", () => {
    expect(getYamlValue(VALUES, ["image", "tag"])).toBe("sha-000000000000");
  });

  test("ignora comentário de fim de linha", () => {
    expect(getYamlValue(VALUES, ["image", "tag"])).not.toContain("#");
  });

  test("distingue blocos homônimos", () => {
    expect(getYamlValue(VALUES, ["ingress", "tag"])).toBe("isso-nao-e-a-imagem");
  });

  test("chave ausente devolve null", () => {
    expect(getYamlValue(VALUES, ["image", "digest"])).toBeNull();
  });

  test("ida e volta: escreve e lê o mesmo valor", () => {
    const out = setYamlValue(VALUES, ["image", "tag"], "sha-deadbeef1234");
    expect(getYamlValue(out, ["image", "tag"])).toBe("sha-deadbeef1234");
  });
});

describe("só filhos diretos casam com o caminho", () => {
  const values = [
    "backend:",
    "  sidecar:",
    "    image:",
    '      tag: "sidecar-1"',
    "  image:",
    '    tag: "app-1"',
  ].join("\n");

  test("setYamlValue não altera a chave homônima de um neto", () => {
    const out = setYamlValue(values, ["backend", "image", "tag"], "app-2");
    expect(out).toContain('      tag: "sidecar-1"');
    expect(out).toContain('    tag: "app-2"');
  });

  test("getYamlValue lê a chave do nível certo", () => {
    expect(getYamlValue(values, ["backend", "image", "tag"])).toBe("app-1");
  });

  test("chave que só existe mais funda não conta como encontrada", () => {
    expect(getYamlValue("a:\n  b:\n    c: 1\n", ["a", "c"])).toBeNull();
    expect(() => setYamlValue("a:\n  b:\n    c: 1\n", ["a", "c"], "2")).toThrow();
  });
});

test("no nível raiz, chave aninhada em outro bloco não casa", () => {
  const yaml = 'backend:\n  image:\n    tag: "b"\nimage:\n  tag: "root"\n';
  expect(getYamlValue(yaml, ["image", "tag"])).toBe("root");
  expect(setYamlValue(yaml, ["image", "tag"], "new")).toBe('backend:\n  image:\n    tag: "b"\nimage:\n  tag: "new"\n');
});
