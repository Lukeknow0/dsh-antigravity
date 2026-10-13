/**
 * Multi-account pool manager for Google Antigravity / Cloud Code Assist.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { redactSecrets, writePrivateJson } from "./security.js";

export function accountsPoolPath() {
  return dshHomePath("storages", "antigravity-pool-accounts.json");
}

export function legacyCredentialPath() {
  return dshHomePath("storages", "antigravity-oauth.json");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class AccountPoolManager {
  #file;
  #legacyFile;
  #chain = Promise.resolve();
  #accounts = [];
  #schedulingMode = "auto"; // "auto" | "primary-backup" | "manual"
  #activeAccountId = null;
  #defaultImageModel = "gemini-3.1-flash-image";
  #imageOutputDir = "./assets/images";
  #initialized = false;
  #initPromise;
  #requestBlockedUntil = 0;

  constructor(file = accountsPoolPath(), legacyFile = legacyCredentialPath()) {
    this.#file = file;
    this.#legacyFile = legacyFile;
  }

  async init() {
    if (this.#initialized) return;
    if (!this.#initPromise) {
      this.#initPromise = this.#load().then(() => { this.#initialized = true; });
    }
    try { await this.#initPromise; } finally { this.#initPromise = undefined; }
  }

  async #load() {
    try {
      if (existsSync(this.#file)) {
        const raw = JSON.parse(await readFile(this.#file, "utf8"));
        if (isRecord(raw)) {
          this.#schedulingMode = raw.schedulingMode || "auto";
          this.#activeAccountId = raw.activeAccountId || null;
          this.#requestBlockedUntil = Number.isFinite(raw.requestBlockedUntil) ? raw.requestBlockedUntil : 0;
          this.#defaultImageModel = raw.defaultImageModel || "gemini-3.1-flash-image";
          this.#imageOutputDir = raw.imageOutputDir || "./assets/images";
          this.#accounts = Array.isArray(raw.accounts) ? raw.accounts : [];
          return;
        }
      }
    } catch (err) {
      throw new Error("Unable to read account pool: " + redactSecrets(err.message));
    }

    // Migration fallback: import legacy antigravity-oauth.json if pool is empty
    if (this.#accounts.length === 0 && existsSync(this.#legacyFile)) {
      try {
        const legacy = JSON.parse(await readFile(this.#legacyFile, "utf8"));
        if (isRecord(legacy) && legacy.refresh) {
          const legacyAccount = {
            id: "acc_" + Date.now().toString(36),
            email: legacy.email || "primary@gmail.com",
            planLabel: "PRO",
            refresh: legacy.refresh,
            access: legacy.access || "",
            expires: typeof legacy.expires === "number" ? legacy.expires : 0,
            projectId: legacy.projectId || "",
            isPrimary: true,
            cooldownUntil: 0,
            lastError: null,
            quota: null,
            createdAt: Date.now(),
          };
          this.#accounts = [legacyAccount];
          this.#activeAccountId = legacyAccount.id;
          await this.#save();
          console.info("[Antigravity Pool] Migrated legacy credentials");
        }
      } catch (err) {
        throw new Error("Unable to migrate account pool: " + redactSecrets(err.message));
      }
    }
  }

  async #save() {
    const payload = {
      schedulingMode: this.#schedulingMode,
      requestBlockedUntil: this.#requestBlockedUntil,
      activeAccountId: this.#activeAccountId,
      defaultImageModel: this.#defaultImageModel,
      imageOutputDir: this.#imageOutputDir,
      updatedAt: Date.now(),
      accounts: this.#accounts,
    };
    await writePrivateJson(this.#file, payload);
  }

  async getStatus() {
    await this.init();
    return {
      schedulingMode: this.#schedulingMode,
      requestPauseRemainingMs: Math.max(0, this.#requestBlockedUntil - Date.now()),
      activeAccountId: this.#activeAccountId,
      defaultImageModel: this.#defaultImageModel,
      imageOutputDir: this.#imageOutputDir,
      accounts: this.#accounts.map((acc) => ({
        id: acc.id,
        email: acc.email,
        planLabel: acc.planLabel || "PRO",
        isPrimary: Boolean(acc.isPrimary),
        suspended: Boolean(acc.suspended),
        inCooldown: (acc.cooldownUntil || 0) > Date.now(),
        cooldownRemainingMs: Math.max(0, (acc.cooldownUntil || 0) - Date.now()),
        lastError: acc.lastError ? redactSecrets(acc.lastError).slice(0, 500) : null,
        quota: this.#publicQuota(acc.quota),
        quotaError: acc.quotaError ? redactSecrets(acc.quotaError).slice(0, 500) : null,
        quotaStale: Boolean(acc.quotaError) || !acc.quota?.fetchedAt ||
          acc.quota?.schemaVersion !== 2 || Date.now() - acc.quota.fetchedAt > 5 * 60 * 1000,
      })),
    };
  }

  async addOrUpdateAccount(credentials) {
    await this.init();
    return this.#modify(async () => {
      const email = credentials.email || "unknown@gmail.com";
      const existing = this.#accounts.find((a) => a.email === email || (credentials.id && a.id === credentials.id));
      if (existing) {
        existing.refresh = credentials.refresh || existing.refresh;
        existing.access = credentials.access || existing.access;
        existing.expires = credentials.expires || existing.expires;
        existing.projectId = credentials.projectId || existing.projectId;
        existing.planLabel = credentials.planLabel || existing.planLabel || "PRO";
        existing.lastError = null;
        existing.cooldownUntil = 0;
        existing.suspended = false;
        existing.updatedAt = Date.now();
        console.info("[Antigravity Pool] Updated account credentials");
      } else {
        const isFirst = this.#accounts.length === 0;
        const newAcc = {
          id: "acc_" + Date.now().toString(36) + "_" + randomBytes(2).toString("hex"),
          email,
          planLabel: credentials.planLabel || "PRO",
          refresh: credentials.refresh,
          access: credentials.access,
          expires: credentials.expires,
          projectId: credentials.projectId,
          isPrimary: isFirst,
          cooldownUntil: 0,
          lastError: null,
          quota: null,
          createdAt: Date.now(),
        };
        this.#accounts.push(newAcc);
        if (isFirst || !this.#activeAccountId) {
          this.#activeAccountId = newAcc.id;
        }
        console.info("[Antigravity Pool] Added account");
      }
      await this.#save();
    });
  }

  async removeAccount(id) {
    await this.init();
    return this.#modify(async () => {
      const idx = this.#accounts.findIndex((a) => a.id === id);
      if (idx !== -1) {
        const wasPrimary = this.#accounts[idx].isPrimary;
        this.#accounts.splice(idx, 1);
        if (wasPrimary && this.#accounts.length > 0) {
          this.#accounts[0].isPrimary = true;
        }
        if (this.#activeAccountId === id) {
          this.#activeAccountId = this.#accounts[0]?.id || null;
        }
        await this.#save();
      }
    });
  }

  async setPrimaryAccount(id) {
    await this.init();
    return this.#modify(async () => {
      for (const acc of this.#accounts) {
        acc.isPrimary = acc.id === id;
      }
      this.#activeAccountId = id;
      await this.#save();
    });
  }

  async updateConfig(config) {
    await this.init();
    return this.#modify(async () => {
      if (typeof config.schedulingMode === "string") {
        if (!["auto", "primary-backup", "manual"].includes(config.schedulingMode)) throw new Error("Invalid scheduling mode");
        this.#schedulingMode = config.schedulingMode;
      }
      if (typeof config.activeAccountId === "string") {
        this.#activeAccountId = config.activeAccountId;
      }
      if (typeof config.defaultImageModel === "string") {
        this.#defaultImageModel = config.defaultImageModel;
      }
      if (typeof config.imageOutputDir === "string") {
        this.#imageOutputDir = config.imageOutputDir;
      }
      await this.#save();
    });
  }

  async updateAccountQuota(id, quota, planLabel) {
    await this.init();
    return this.#modify(async () => {
      const acc = this.#accounts.find((a) => a.id === id);
      if (!acc) return;
      acc.quota = quota;
      acc.quotaError = null;
      if (planLabel) acc.planLabel = planLabel;
      await this.#save();
    });
  }

  #publicQuota(quota) {
    if (!quota) return null;
    if (quota.schemaVersion === 2) return quota;
    // Older versions persisted missing values as zero; their provenance is lost.
    return {
      ...quota,
      groups: (quota.groups || []).map((group) => ({
        ...group,
        buckets: (group.buckets || []).map((bucket) => ({
          ...bucket,
          remainingFraction: bucket.remainingFraction === 0 ? null : bucket.remainingFraction,
        })),
      })),
    };
  }

  async markQuotaError(id, error) {
    await this.init();
    return this.#modify(async () => {
      const acc = this.#accounts.find((a) => a.id === id);
      if (!acc) return;
      acc.quotaError = redactSecrets(error).slice(0, 500);
      await this.#save();
    });
  }

  async markCooldown(id, durationMs = 60000, reason = "") {
    await this.init();
    return this.#modify(async () => {
      const acc = this.#accounts.find((a) => a.id === id);
      if (!acc) return;
      acc.cooldownUntil = Math.max(acc.cooldownUntil || 0, Date.now() + Math.max(0, durationMs));
      acc.lastError = redactSecrets(reason || "Rate limited (429)").slice(0, 500);
      await this.#save();
    });
  }

  async clearCooldown(id) {
    await this.init();
    return this.#modify(async () => {
      const acc = this.#accounts.find((a) => a.id === id);
      if (!acc) return;
      acc.cooldownUntil = 0;
      acc.lastError = null;
      await this.#save();
    });
  }

  async pauseRequests(durationMs = 60000) {
    await this.init();
    return this.#modify(async () => {
      this.#requestBlockedUntil = Math.max(this.#requestBlockedUntil, Date.now() + Math.max(0, durationMs));
      await this.#save();
    });
  }

  async suspendAccount(id, reason = "AUTH") {
    await this.init();
    return this.#modify(async () => {
      const acc = this.#accounts.find(a => a.id === id);
      if (!acc) return;
      acc.suspended = true;
      acc.lastError = redactSecrets(reason).slice(0, 500);
      await this.#save();
    });
  }

  async updateAccountCredentials(id, credentials) {
    await this.init();
    return this.#modify(async () => {
      const acc = this.#accounts.find(a => a.id === id);
      if (!acc) return;
      for (const field of ["refresh", "access", "expires", "projectId"]) {
        if (credentials[field] !== undefined) acc[field] = credentials[field];
      }
      await this.#save();
    });
  }

  /** Select healthy accounts only, never use cooling accounts as fallback. */
  async getCandidateAccounts(category = "gemini") {
    await this.init();
    const now = Date.now();
    if (this.#requestBlockedUntil > now) return [];
    const available = this.#accounts.filter(a => !a.suspended && (a.cooldownUntil || 0) <= now);
    if (this.#schedulingMode === "manual") {
      return available.filter(a => a.id === this.#activeAccountId).slice(0, 1);
    }
    if (this.#schedulingMode === "primary-backup") {
      const primary = available.find(a => a.isPrimary);
      return primary ? [primary, ...available.filter(a => a.id !== primary.id)] : available;
    }

    // "auto": Smart balancing based on highest remaining quota fraction
    const quotaFraction = (acc) => {
      const groups = acc.quota?.groups || [];
      const fractions = groups
        .filter((g) => category === "claude"
          ? /claude|gpt/i.test(g.displayName || g.name || "")
          : /gemini/i.test(g.displayName || g.name || ""))
        .flatMap((g) => g.buckets || g.limits || [])
        .map((limit) => limit.remainingFraction)
        .filter((value) => typeof value === "number" && Number.isFinite(value));
      // Every window constrains availability, including the weekly cap.
      return fractions.length ? Math.min(...fractions) : 1;
    };

    const sortedAvailable = [...available].sort((a, b) => quotaFraction(b) - quotaFraction(a));
    return sortedAvailable;
  }

  get defaultImageModel() {
    return this.#defaultImageModel;
  }

  get imageOutputDir() {
    return this.#imageOutputDir;
  }

  get allAccounts() {
    return this.#accounts;
  }

  #modify(fn) {
    const next = (async () => {
      await this.#chain.catch(() => {});
      await fn();
    })();
    this.#chain = next.catch(() => {});
    return next;
  }
}
