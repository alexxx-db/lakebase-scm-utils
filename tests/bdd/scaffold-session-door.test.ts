import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

// P5 (layering-door scaffold): the request-scoped DB session door is shipped in the REPOSITORY
// layer (app/repositories/session.py: get_session), NOT as a get_db dependency in infrastructure
// (app/database.py). This is what stops a service-backed feature's boundary from importing the DB
// session from infrastructure — the stockflow S1 `from app.database import get_db` layering
// violation that forced a review->refactor lap. The driver depends on a session the service
// exposes (sourced from this repository-layer door); app/database.py stays pure infrastructure.

const TEMPLATES = path.resolve(__dirname, "..", "..", "templates", "project");
const read = (rel: string): string => readFileSync(path.join(TEMPLATES, rel), "utf8");
const has = (rel: string): boolean => existsSync(path.join(TEMPLATES, rel));

describe("scaffold session door lives in the repository layer (P5)", () => {
  it("ships app/repositories/ as a package with the session door", () => {
    expect(has("python/app/repositories/__init__.py")).toBe(true);
    expect(has("python/app/repositories/session.py")).toBe(true);
  });

  it("repositories/session.py defines get_session, sourcing SessionLocal from infrastructure", () => {
    const s = read("python/app/repositories/session.py");
    expect(s).toMatch(/def get_session\(/);
    expect(s).toMatch(/from app\.database import SessionLocal/);
    expect(s).toMatch(/SessionLocal\(\)/);
    expect(s).toMatch(/finally:/); // always closes
  });

  it("app/database.py is pure infrastructure — no get_db session dependency", () => {
    const db = read("python/app/database.py");
    expect(db).not.toMatch(/def get_db\b/); // the removed temptation
    // still the infra building blocks
    expect(db).toMatch(/SessionLocal = sessionmaker/);
    expect(db).toMatch(/class Base\(DeclarativeBase\)/);
    // and it points at the repository-layer door rather than hosting one
    expect(db).toMatch(/app\/repositories\/session\.py/);
  });
});
