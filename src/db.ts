/**
 * 本地索引库。用 Node 内置的 node:sqlite，不引第三方依赖。
 *
 * 设计要点：
 * - guid 是全局主键（省级平台与各地市站点的 infoid 同值），天然去重。
 * - project_type 存站点口径，primary_tag/tags 存我们的业务口径，两者分开，
 *   这样以后换分类规则只要重算 tag，不用重抓。
 * - body_text 保留全文，便于后续换关键词时离线重跑分类，不必回源。
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Tag } from './config.ts';
import { compactEvidence, type Classification } from './classify.ts';
import type { ListItem, Detail } from './source/provincial.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS announcement (
  guid            TEXT PRIMARY KEY,
  city            TEXT NOT NULL,
  district        TEXT NOT NULL,
  title           TEXT NOT NULL,
  pub_date        TEXT NOT NULL,
  bulletin_nature TEXT NOT NULL,
  project_type    TEXT NOT NULL,
  primary_tag     TEXT,
  tags            TEXT,
  evidence        TEXT,
  body_text       TEXT NOT NULL,
  origin_url      TEXT,
  detail_type     TEXT,
  detail_bytes    INTEGER NOT NULL,
  fetched_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ann_pubdate ON announcement(pub_date);
CREATE INDEX IF NOT EXISTS idx_ann_primary ON announcement(primary_tag);
CREATE INDEX IF NOT EXISTS idx_ann_city    ON announcement(city);
CREATE INDEX IF NOT EXISTS idx_ann_nature  ON announcement(bulletin_nature);

-- 断点：记录每个 (行业分类 × 公告性质) 组合已经翻到第几页。
-- 全量跑几小时，必须能中断后从断点继续，而不是从头再来。
CREATE TABLE IF NOT EXISTS crawl_state (
  tender_project_type TEXT NOT NULL,
  bulletin_nature     TEXT NOT NULL,
  next_page           INTEGER NOT NULL DEFAULT 1,
  finished            INTEGER NOT NULL DEFAULT 0,
  scanned             INTEGER NOT NULL DEFAULT 0,
  updated_at          TEXT NOT NULL,
  PRIMARY KEY (tender_project_type, bulletin_nature)
);

-- 失败隔离：单条失败不影响整体，跑完统一补跑。
CREATE TABLE IF NOT EXISTS crawl_failure (
  guid       TEXT PRIMARY KEY,
  tender_project_type TEXT NOT NULL,
  bulletin_nature     TEXT NOT NULL,
  title      TEXT NOT NULL,
  stage      TEXT NOT NULL,
  reason     TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 附件清单。附件正文下载功能尚未实现（验证码未突破），此表先建好占位。
-- 一个公告常有多个附件，attach_guid 是站点给的附件唯一 ID，可做去重。
CREATE TABLE IF NOT EXISTS attachment (
  attach_guid       TEXT PRIMARY KEY,
  announcement_guid TEXT NOT NULL,
  filename          TEXT NOT NULL,
  ext               TEXT,
  size_bytes        INTEGER,
  /** 相对 data/ 的路径，如 attachments/光伏/2026-10/3e5b86ac/招标文件正文.pdf */
  local_path        TEXT,
  /** pending / ok / captcha_failed / http_failed / skipped */
  status            TEXT NOT NULL,
  sha256            TEXT,
  reason            TEXT,
  downloaded_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_att_ann    ON attachment(announcement_guid);
CREATE INDEX IF NOT EXISTS idx_att_status ON attachment(status);

-- 公告与附件的关联（多对多）。
--
-- 为什么需要它：attachment 以 attach_guid 为主键，announcement_guid 只记“首次写入者”。
-- 但同一批附件会同时挂在多条公告上（省级平台与地市站重新发布同一公告、或同一项目的
-- 多个标段各自列同一份招标文件），于是兄弟公告永远拿不到自己的关联，在统计上表现为
-- “这篇公告零附件”，实际文件早已下到本地。
-- 本表记录“哪些公告页面列出过这个附件”，不替代 attachment 的存储归属。
CREATE TABLE IF NOT EXISTS announcement_attachment (
  announcement_guid TEXT NOT NULL,
  attach_guid       TEXT NOT NULL,
  recorded_at       TEXT NOT NULL,
  PRIMARY KEY (announcement_guid, attach_guid)
);

CREATE INDEX IF NOT EXISTS idx_annatt_att ON announcement_attachment(attach_guid);
`;

export interface CrawlState {
  nextPage: number;
  finished: boolean;
  scanned: number;
}

export interface UpsertRecord {
  item: ListItem;
  detail: Detail;
  classification: Classification;
}

export class IndexDb {
  readonly db: DatabaseSync;
  readonly #stmt: ReturnType<DatabaseSync['prepare']>;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    // SQLite 的写锁是排他的，WAL 也只支持一写多读。
    // 默认 busy_timeout=0，多个进程同时写会直接抛 database is locked；
    // 设成 30 秒可让后来的进程等锁而不是掊溃。
    this.db.exec('PRAGMA busy_timeout = 30000;');
    this.db.exec(SCHEMA);

    this.#stmt = this.db.prepare(`
      INSERT INTO announcement (
        guid, city, district, title, pub_date, bulletin_nature, project_type,
        primary_tag, tags, evidence, body_text, origin_url, detail_type, detail_bytes, fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(guid) DO UPDATE SET
        title = excluded.title,
        pub_date = excluded.pub_date,
        primary_tag = excluded.primary_tag,
        tags = excluded.tags,
        evidence = excluded.evidence,
        body_text = excluded.body_text,
        origin_url = excluded.origin_url,
        detail_type = excluded.detail_type,
        detail_bytes = excluded.detail_bytes,
        fetched_at = excluded.fetched_at
    `);
  }

  upsert({ item, detail, classification }: UpsertRecord): void {
    this.#stmt.run(
      item.guid,
      item.city,
      item.district,
      item.title,
      item.pubDate,
      item.bulletinNature,
      item.projectType,
      classification.primaryTag,
      JSON.stringify(classification.tags),
      compactEvidence(classification),
      detail.text,
      detail.originUrl,
      detail.usedType,
      detail.bytes,
      new Date().toISOString(),
    );
  }

  has(guid: string): boolean {
    const row = this.db.prepare('SELECT 1 AS x FROM announcement WHERE guid = ?').get(guid);
    return row !== undefined;
  }

  // ---- 断点 ----

  getCrawlState(type: string, nature: string): CrawlState {
    const row = this.db
      .prepare(
        'SELECT next_page AS nextPage, finished, scanned FROM crawl_state WHERE tender_project_type = ? AND bulletin_nature = ?',
      )
      .get(type, nature) as { nextPage: number; finished: number; scanned: number } | undefined;

    if (!row) return { nextPage: 1, finished: false, scanned: 0 };
    return { nextPage: row.nextPage, finished: row.finished === 1, scanned: row.scanned };
  }

  saveCrawlState(type: string, nature: string, nextPage: number, finished: boolean, scanned: number): void {
    this.db
      .prepare(
        `INSERT INTO crawl_state (tender_project_type, bulletin_nature, next_page, finished, scanned, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(tender_project_type, bulletin_nature) DO UPDATE SET
           next_page = excluded.next_page,
           finished  = excluded.finished,
           scanned   = excluded.scanned,
           updated_at = excluded.updated_at`,
      )
      .run(type, nature, nextPage, finished ? 1 : 0, scanned, new Date().toISOString());
  }

  // ---- 失败 ----

  recordFailure(
    item: { guid: string; tenderProjectType: string; bulletinNature: string; title: string },
    stage: string,
    reason: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO crawl_failure (guid, tender_project_type, bulletin_nature, title, stage, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(guid) DO UPDATE SET reason = excluded.reason, created_at = excluded.created_at`,
      )
      .run(
        item.guid,
        item.tenderProjectType,
        item.bulletinNature,
        item.title.slice(0, 200),
        stage,
        reason.slice(0, 500),
        new Date().toISOString(),
      );
  }

  failureCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM crawl_failure').get() as { n: number };
    return row.n;
  }

  listFailures(limit = 50): Array<{ guid: string; title: string; stage: string; reason: string }> {
    return this.db
      .prepare('SELECT guid, title, stage, reason FROM crawl_failure ORDER BY created_at DESC LIMIT ?')
      .all(limit) as Array<{ guid: string; title: string; stage: string; reason: string }>;
  }

  /** 取出全部失败记录，按阶段分组，供补跑使用。 */
  allFailures(): Array<{
    guid: string;
    tenderProjectType: string;
    bulletinNature: string;
    title: string;
    stage: string;
    reason: string;
  }> {
    return this.db
      .prepare(
        `SELECT guid, tender_project_type AS tenderProjectType, bulletin_nature AS bulletinNature,
                title, stage, reason
         FROM crawl_failure ORDER BY stage, tender_project_type, title`,
      )
      .all() as Array<{
      guid: string;
      tenderProjectType: string;
      bulletinNature: string;
      title: string;
      stage: string;
      reason: string;
    }>;
  }

  /** 补跑成功后清除失败记录。 */
  removeFailure(guid: string): void {
    this.db.prepare('DELETE FROM crawl_failure WHERE guid = ?').run(guid);
  }

  // ---- 附件 ----

  /**
   * 只把 status='ok' 视为已完成。
   * failed 的附件允许重试：失败可能是当时类型白名单不全或站点短暂异常。
   */
  hasAttachment(attachGuid: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS x FROM attachment WHERE attach_guid = ? AND status = 'ok'")
      .get(attachGuid);
    return row !== undefined;
  }

  /**
   * 取这条附件已记录的本地路径（相对 data/），没有则 null。
   * 重下时用它判定“这个文件归我”，避免把别人的文件当成自己的去覆盖。
   */
  localPathOf(attachGuid: string): string | null {
    const row = this.db
      .prepare('SELECT local_path AS p FROM attachment WHERE attach_guid = ?')
      .get(attachGuid) as { p: string | null } | undefined;
    return row?.p ?? null;
  }

  /**
   * 记下「这篇公告的页面列出过这个附件」。
   * 即使附件已存在、不需要重下，也要调它——否则兄弟公告永远补不上关联。
   */
  linkAttachment(announcementGuid: string, attachGuid: string): void {
    this.db
      .prepare(
        `INSERT INTO announcement_attachment (announcement_guid, attach_guid, recorded_at)
         VALUES (?, ?, ?) ON CONFLICT(announcement_guid, attach_guid) DO NOTHING`,
      )
      .run(announcementGuid, attachGuid, new Date().toISOString());
  }

  upsertAttachment(a: {
    attachGuid: string;
    announcementGuid: string;
    filename: string;
    ext: string;
    sizeBytes: number | null;
    localPath: string | null;
    status: string;
    sha256: string | null;
    reason: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO attachment
           (attach_guid, announcement_guid, filename, ext, size_bytes, local_path, status, sha256, reason, downloaded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(attach_guid) DO UPDATE SET
           filename = excluded.filename,
           ext = excluded.ext,
           size_bytes = excluded.size_bytes,
           local_path = excluded.local_path,
           status = excluded.status,
           sha256 = excluded.sha256,
           reason = excluded.reason,
           downloaded_at = excluded.downloaded_at`,
      )
      .run(
        a.attachGuid,
        a.announcementGuid,
        a.filename,
        a.ext,
        a.sizeBytes,
        a.localPath,
        a.status,
        a.sha256,
        a.reason,
        new Date().toISOString(),
      );

    // 存储归属与“哪些公告引用它”是两件事：每次写入都补一条关联。
    this.linkAttachment(a.announcementGuid, a.attachGuid);
  }

  attachmentStats(): Array<{ status: string; n: number; mb: number }> {
    return this.db
      .prepare(
        `SELECT status, COUNT(*) AS n, ROUND(COALESCE(SUM(size_bytes),0)/1048576.0, 1) AS mb
         FROM attachment GROUP BY status ORDER BY n DESC`,
      )
      .all() as Array<{ status: string; n: number; mb: number }>;
  }

  /**
   * 只重算分类，不重抓正文。调整关键词规则后用它离线刷新，
   * 避免为了改几个正则就把几千条公告重新抓一遍。
   */
  reclassifyAll(reclassify: (title: string, body: string) => Classification): number {
    const rows = this.db
      .prepare('SELECT guid, title, body_text AS body FROM announcement')
      .all() as Array<{ guid: string; title: string; body: string }>;

    const stmt = this.db.prepare(
      'UPDATE announcement SET primary_tag = ?, tags = ?, evidence = ? WHERE guid = ?',
    );

    for (const r of rows) {
      const c = reclassify(r.title, r.body);
      stmt.run(
        c.primaryTag,
        JSON.stringify(c.tags),
        compactEvidence(c),
        r.guid,
      );
    }
    return rows.length;
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM announcement').get() as { n: number };
    return row.n;
  }

  /** 按类别统计，primary_tag 唯一计数，避免多标签重复统计。 */
  statsByTag(): Array<{ tag: Tag | null; n: number }> {
    return this.db
      .prepare('SELECT primary_tag AS tag, COUNT(*) AS n FROM announcement GROUP BY primary_tag ORDER BY n DESC')
      .all() as Array<{ tag: Tag | null; n: number }>;
  }

  statsByCity(): Array<{ city: string; n: number }> {
    return this.db
      .prepare('SELECT city, COUNT(*) AS n FROM announcement GROUP BY city ORDER BY n DESC')
      .all() as Array<{ city: string; n: number }>;
  }

  close(): void {
    this.db.close();
  }
}
