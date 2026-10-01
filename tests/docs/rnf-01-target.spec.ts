import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const prd = readFileSync("docs/prd/PRD-001-mvp.md", "utf8");
const backlog = JSON.parse(readFileSync("docs/backlog/PRD-001.json", "utf8")) as {
  tasks?: { id: string; acceptance: string }[];
};
const rnf01 = prd.split("\n").find((line) => line.startsWith("| RNF-01 |")) ?? "";
const acceptance = JSON.stringify(backlog).match(/"id": ?"MNE-001-390".*?"acceptance": ?"([^"]*)"/)?.[1] ?? "";

describe("RNF-01 target names the gate and carries no drifting figure", () => {
  it("names the floor check that enforces it", () => {
    expect(rnf01).toContain("plan:status -- --piso");
    expect(rnf01).toContain("docs/criterios-minimos.json");
    expect(acceptance).toContain("plan:status -- --piso");
  });

  it("does not hardcode a passing-criteria count", () => {
    expect(rnf01).not.toMatch(/\d+\/\d+/);
    expect(acceptance).not.toMatch(/\d+\/\d+/);
  });
});
