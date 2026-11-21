'use strict';

const { Plugin, PluginSettingTab, Setting, Notice, TFile, TFolder, requestUrl, normalizePath } = require('obsidian');

const API = 'https://api.spotify.com/v1';
const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SCOPES = 'playlist-read-private playlist-read-collaborative';
// Not formatı değişince artırılır; bir sonraki senkronda bütün notlar yeniden yazılır.
const NOTE_FORMAT = 2;

const DEFAULT_SETTINGS = {
	clientId: '',
	redirectPort: 8888,
	folder: '001 Playlist/01 Profil',
	unyetFolder: '001 Playlist/02 Unyet',
	othersFolder: '001 Playlist/03 And Others',
	coverFolder: '001 Playlist/04 pl kapak',
	intervalMinutes: 60,
	syncOnStartup: true,
};

const DEFAULT_AUTH = { accessToken: '', refreshToken: '', expiresAt: 0, userId: '', userName: '' };

// ---------- yardımcılar ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function randomString(len) {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
	const bytes = crypto.getRandomValues(new Uint8Array(len));
	return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

async function pkceChallenge(verifier) {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
	return btoa(String.fromCharCode(...new Uint8Array(digest)))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}

// Spotify açıklamaları HTML entity ve <a> etiketleri içeriyor.
function cleanDescription(html) {
	if (!html) return '';
	const el = document.createElement('textarea');
	el.innerHTML = html.replace(/<[^>]*>/g, '');
	return el.value.replace(/\s*\r?\n\s*/g, ' ').trim();
}

// Emojiler (bayrak, ten rengi, birleşik emojiler dahil); Remotely Save bunlarla yükleme yapamıyor.
const EMOJI = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u{1F3FB}-\u{1F3FF}‍︎️⃣]/gu;

// Dosya adında emojileri, Windows'un kabul etmediği ve Obsidian linklerini bozan karakterleri temizler.
function sanitizeName(name) {
	const s = String(name || '')
		.replace(EMOJI, '')
		.replace(/#/g, '♯')
		.replace(/\[/g, '(')
		.replace(/\]/g, ')')
		.replace(/[|:/\\]/g, '-')
		.replace(/[\^*"<>?]/g, '')
		.replace(/[\u0000-\u001f]/g, '')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/^\.+/, '')
		.replace(/[. ]+$/, '');
	return s.slice(0, 100).trim() || 'Adsız playlist';
}

const pad3 = (n) => String(n).padStart(3, '0');

const GROUPS = [
	{ key: 'profil', label: 'Profil', setting: 'folder' },
	{ key: 'unyet', label: 'Unyet', setting: 'unyetFolder' },
	{ key: 'others', label: 'And Others', setting: 'othersFolder' },
];

// Eski sürümdeki { hidden } alanını { group } alanına çevirir: profilde olmayanlar Unyet'e gider.
function migrateOrderEntry(o) {
	if (o.group) return o;
	const { hidden, ...rest } = o;
	return { ...rest, group: hidden ? 'unyet' : 'profil' };
}

// ---------- eklenti ----------

module.exports = class SpotifyPlaylistSync extends Plugin {
	async onload() {
		const saved = (await this.loadData()) || {};
		this.data = {
			settings: Object.assign({}, DEFAULT_SETTINGS, saved.settings),
			auth: Object.assign({}, DEFAULT_AUTH, saved.auth),
			// Sıra ve klasör: [{ id, name, group }], group: 'profil' | 'unyet' | 'none'
			order: (saved.order || []).map(migrateOrderEntry),
			// İlk senkronda kullanılacak profil sırası (playlist adları)
			orderHint: saved.orderHint || [],
			// playlist id -> { path, coverPath, coverUrl, snapshotId, name, description }
			cache: saved.cache || {},
			lastSync: saved.lastSync || 0,
		};
		this.syncing = false;
		this.resyncRequested = false;
		this.timer = null;
		this.pendingSync = null;
		this.authServer = null;

		this.statusEl = this.addStatusBarItem();
		this.updateStatus();

		this.addRibbonIcon('music', 'Spotify playlistlerini senkronize et', () => this.sync({ manual: true }));
		this.addCommand({
			id: 'sync-now',
			name: 'Playlistleri şimdi senkronize et',
			callback: () => this.sync({ manual: true }),
		});
		this.addCommand({
			id: 'sync-force',
			name: 'Tüm playlistleri baştan yaz',
			callback: () => this.sync({ manual: true, force: true }),
		});
		this.addCommand({
			id: 'connect',
			name: 'Spotify hesabını bağla',
			callback: () => this.connect(),
		});

		this.addSettingTab(new SpotifySettingTab(this.app, this));
		this.restartTimer();

		this.app.workspace.onLayoutReady(() => {
			if (this.data.settings.syncOnStartup && this.data.auth.refreshToken) {
				window.setTimeout(() => this.sync({ manual: false }), 5000);
			}
		});
	}

	onunload() {
		this.closeAuthServer();
		if (this.pendingSync) window.clearTimeout(this.pendingSync);
	}

	get settings() {
		return this.data.settings;
	}

	get redirectUri() {
		return `http://127.0.0.1:${this.settings.redirectPort}/callback`;
	}

	async save() {
		await this.saveData(this.data);
	}

	restartTimer() {
		if (this.timer) window.clearInterval(this.timer);
		this.timer = null;
		const minutes = Number(this.settings.intervalMinutes);
		if (minutes > 0) {
			this.timer = window.setInterval(() => this.sync({ manual: false }), minutes * 60 * 1000);
			this.registerInterval(this.timer);
		}
	}

	// Sıralama ayarları değişince birkaç saniye bekleyip dosyaları yeniden numaralar.
	scheduleSync() {
		if (this.pendingSync) window.clearTimeout(this.pendingSync);
		this.pendingSync = window.setTimeout(() => {
			this.pendingSync = null;
			this.sync({ manual: false });
		}, 3000);
	}

	updateStatus(text) {
		if (text) {
			this.statusEl.setText(text);
			return;
		}
		if (!this.data.lastSync) {
			this.statusEl.setText('');
			return;
		}
		const t = new Date(this.data.lastSync);
		this.statusEl.setText(`Spotify ♪ ${t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
	}

	// ---------- kimlik doğrulama (PKCE + yerel geri dönüş sunucusu) ----------

	async connect() {
		if (!this.settings.clientId) {
			new Notice('Önce ayarlardan Spotify Client ID gir.');
			return;
		}
		try {
			const verifier = randomString(64);
			const state = randomString(16);
			const params = new URLSearchParams({
				client_id: this.settings.clientId,
				response_type: 'code',
				redirect_uri: this.redirectUri,
				code_challenge_method: 'S256',
				code_challenge: await pkceChallenge(verifier),
				scope: SCOPES,
				state,
			});
			new Notice('Tarayıcıda Spotify izin sayfası açılıyor…');
			const code = await this.waitForAuthCode(state, `${AUTH_URL}?${params}`);
			await this.tokenRequest({
				grant_type: 'authorization_code',
				code,
				redirect_uri: this.redirectUri,
				client_id: this.settings.clientId,
				code_verifier: verifier,
			});
			const me = await this.api('/me');
			this.data.auth.userId = me.id;
			this.data.auth.userName = me.display_name || me.id;
			await this.save();
			new Notice(`Spotify bağlandı: ${this.data.auth.userName}`);
			this.sync({ manual: true });
		} catch (e) {
			console.error('[spotify-playlist-sync]', e);
			new Notice(`Spotify bağlantısı başarısız: ${e.message}`, 10000);
		}
	}

	waitForAuthCode(expectedState, authorizeUrl) {
		const http = require('http');
		const port = Number(this.settings.redirectPort);
		this.closeAuthServer();

		return new Promise((resolve, reject) => {
			let done = false;
			const page = (msg) =>
				`<!doctype html><meta charset="utf-8"><title>Obsidian Spotify</title>` +
				`<body style="font-family:sans-serif;display:grid;place-items:center;height:90vh"><p>${msg}</p></body>`;

			const server = http.createServer((req, res) => {
				const url = new URL(req.url, `http://127.0.0.1:${port}`);
				if (url.pathname !== '/callback') {
					res.writeHead(404);
					res.end();
					return;
				}
				const error = url.searchParams.get('error');
				const code = url.searchParams.get('code');
				const state = url.searchParams.get('state');
				res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
				if (error || !code || state !== expectedState) {
					res.end(page('Bağlantı başarısız. Obsidian’a dönüp tekrar dene.'));
					finish(new Error(error || 'Geçersiz yanıt (state uyuşmuyor)'));
					return;
				}
				res.end(page('Spotify bağlandı. Bu sekmeyi kapatıp Obsidian’a dönebilirsin.'));
				finish(null, code);
			});

			const timeout = setTimeout(() => finish(new Error('5 dakika içinde izin verilmedi')), 5 * 60 * 1000);

			const finish = (err, code) => {
				if (done) return;
				done = true;
				clearTimeout(timeout);
				server.close();
				if (this.authServer === server) this.authServer = null;
				err ? reject(err) : resolve(code);
			};

			server.on('error', (e) =>
				finish(e.code === 'EADDRINUSE' ? new Error(`${port} portu kullanımda, ayarlardan başka port seç`) : e)
			);
			server.listen(port, '127.0.0.1', () => window.open(authorizeUrl));
			this.authServer = server;
		});
	}

	closeAuthServer() {
		if (this.authServer) {
			this.authServer.close();
			this.authServer = null;
		}
	}

	async tokenRequest(params) {
		const res = await requestUrl({
			url: TOKEN_URL,
			method: 'POST',
			contentType: 'application/x-www-form-urlencoded',
			body: new URLSearchParams(params).toString(),
			throw: false,
		});
		if (res.status !== 200) {
			let detail = res.text;
			try {
				detail = res.json.error_description || res.json.error || detail;
			} catch (_) {}
			const err = new Error(`Token alınamadı (${res.status}): ${detail}`);
			err.status = res.status;
			err.invalidGrant = /invalid_grant|revoked|expired/i.test(res.text || '');
			throw err;
		}
		const j = res.json;
		this.data.auth.accessToken = j.access_token;
		this.data.auth.expiresAt = Date.now() + (j.expires_in - 60) * 1000;
		if (j.refresh_token) this.data.auth.refreshToken = j.refresh_token;
		await this.save();
	}

	async getAccessToken() {
		const auth = this.data.auth;
		if (auth.accessToken && Date.now() < auth.expiresAt) return auth.accessToken;
		if (!auth.refreshToken) throw new Error('Spotify hesabı bağlı değil');
		try {
			await this.tokenRequest({
				grant_type: 'refresh_token',
				refresh_token: auth.refreshToken,
				client_id: this.settings.clientId,
			});
		} catch (e) {
			if (e.invalidGrant) {
				auth.refreshToken = '';
				auth.accessToken = '';
				await this.save();
				throw new Error('Spotify oturumu sona ermiş, ayarlardan tekrar bağlan');
			}
			throw e;
		}
		return auth.accessToken;
	}

	async disconnect() {
		this.data.auth = Object.assign({}, DEFAULT_AUTH);
		await this.save();
	}

	// ---------- Spotify API ----------

	async api(pathOrUrl) {
		const url = pathOrUrl.startsWith('http') ? pathOrUrl : API + pathOrUrl;
		for (let attempt = 0; attempt < 6; attempt++) {
			const token = await this.getAccessToken();
			const res = await requestUrl({ url, headers: { Authorization: `Bearer ${token}` }, throw: false });
			if (res.status === 200) return res.json;
			if (res.status === 401 && attempt === 0) {
				this.data.auth.expiresAt = 0;
				continue;
			}
			if (res.status === 429) {
				const h = res.headers || {};
				const wait = parseInt(h['retry-after'] || h['Retry-After'], 10) || 2;
				await sleep(Math.min(wait, 60) * 1000);
				continue;
			}
			if (res.status >= 500) {
				await sleep(1000 * (attempt + 1));
				continue;
			}
			const err = new Error(`Spotify API ${res.status} (${url.replace(API, '')})`);
			err.status = res.status;
			throw err;
		}
		throw new Error(`Spotify API yanıt vermiyor (${url.replace(API, '')})`);
	}

	async paginate(path) {
		const out = [];
		let next = path;
		while (next) {
			const page = await this.api(next);
			out.push(...(page.items || []));
			next = page.next;
		}
		return out;
	}

	async fetchPlaylistItems(id) {
		const query = '?limit=50&additional_types=track,episode';
		try {
			return await this.paginate(`/playlists/${id}/items${query}`);
		} catch (e) {
			// Eski uç nokta (Şubat 2026 öncesi) için yedek
			if (e.status === 404) return await this.paginate(`/playlists/${id}/tracks${query}`);
			throw e;
		}
	}

	// ---------- senkronizasyon ----------

	async sync({ manual = false, force = false } = {}) {
		if (this.syncing) {
			if (manual) new Notice('Spotify senkronizasyonu zaten sürüyor.');
			else this.resyncRequested = true;
			return;
		}
		if (!this.data.auth.refreshToken) {
			if (manual) new Notice('Önce ayarlardan Spotify hesabını bağla.');
			return;
		}

		this.syncing = true;
		this.updateStatus('Spotify ♪ senkronize ediliyor…');
		let updated = 0;
		let unchanged = 0;
		const failed = [];

		try {
			const me = await this.api('/me');
			this.data.auth.userId = me.id;
			this.data.auth.userName = me.display_name || me.id;

			// Sadece sana ait playlistler (herkese açık ve gizli)
			const all = (await this.paginate('/me/playlists?limit=50')).filter(Boolean);
			const fetched = all.filter((p) => p.owner?.id === me.id);
			this.updateOrder(fetched);

			const byId = new Map(fetched.map((p) => [p.id, p]));
			const visible = this.data.order.filter((o) => o.group !== 'none').map((o) => byId.get(o.id));

			for (const g of GROUPS) await this.ensureFolder(this.settings[g.setting]);
			await this.ensureFolder(this.settings.coverFolder);

			await this.removeStale(new Set(visible.map((p) => p.id)));
			const plan = this.planPaths();
			await this.applyRenames(visible, plan);

			for (const pl of visible) {
				try {
					(await this.writePlaylist(pl, plan.get(pl.id), force)) ? updated++ : unchanged++;
				} catch (e) {
					console.error('[spotify-playlist-sync]', pl.name, e);
					failed.push(pl.name);
				}
			}

			this.data.lastSync = Date.now();
			await this.save();
			this.updateStatus();

			if (manual || failed.length) {
				let msg = `Spotify: ${updated} playlist güncellendi, ${unchanged} değişmemiş.`;
				if (failed.length) msg += `\nHata: ${failed.join(', ')}`;
				new Notice(msg, failed.length ? 10000 : 5000);
			}
		} catch (e) {
			console.error('[spotify-playlist-sync]', e);
			this.updateStatus('Spotify ♪ hata');
			new Notice(`Spotify senkronizasyonu başarısız: ${e.message}`, 10000);
		} finally {
			this.syncing = false;
			if (this.resyncRequested) {
				this.resyncRequested = false;
				this.scheduleSync();
			}
		}
	}

	// Kayıtlı sırayı korur; yeni playlistler kendi klasörünün en üstüne eklenir, artık gelmeyenler listeden çıkar.
	// Görünürlüğü değişen (herkese açık <-> gizli) playlist doğru klasörün en üstüne taşınır.
	updateOrder(fetched) {
		if (!this.data.order.length && this.data.orderHint?.length) {
			this.data.order = this.orderFromHint(fetched, this.data.orderHint);
			this.data.orderHint = [];
		}
		const groupFor = (p) => (p.public ? 'profil' : 'others');
		// Spotify sayfalama sırasında aynı playlisti iki kez döndürebiliyor; tekilleştir.
		const byId = new Map(fetched.map((p) => [p.id, p]));
		const kept = [];
		const top = [];
		const seen = new Set();
		for (const o of this.data.order) {
			const p = byId.get(o.id);
			if (!p || seen.has(o.id)) continue;
			seen.add(o.id);
			o.name = p.name;
			const isPublic = p.public === true;
			if (o.public === undefined) o.public = isPublic;
			if (o.public !== isPublic) {
				o.public = isPublic;
				if (o.group !== 'none') {
					o.group = groupFor(p);
					top.push(o);
					continue;
				}
			}
			kept.push(o);
		}
		const fresh = [...byId.values()]
			.filter((p) => !seen.has(p.id))
			.map((p) => ({ id: p.id, name: p.name, public: p.public === true, group: groupFor(p) }));
		this.data.order = [...fresh, ...top, ...kept];
	}

	// İlk kurulumda profildeki sırayı ada göre eşleştirir (kısaltılmış "…" adlar baştan eşleşir).
	// Listede olmayanlar profilde görünmüyor demektir: Unyet'e eklenir. Gizliler And Others'a gider.
	orderFromHint(fetched, hint) {
		const norm = (s) => String(s || '').toLocaleLowerCase('tr').replace(/[.…\s]+$/, '').trim();
		const left = fetched.filter((p) => p.public === true);
		const order = [];
		for (const h of hint.map(norm)) {
			let i = left.findIndex((p) => norm(p.name) === h);
			if (i < 0) i = left.findIndex((p) => norm(p.name).startsWith(h));
			if (i < 0) continue;
			const [p] = left.splice(i, 1);
			order.push({ id: p.id, name: p.name, public: true, group: 'profil' });
		}
		for (const p of left) order.push({ id: p.id, name: p.name, public: true, group: 'unyet' });
		for (const p of fetched.filter((x) => x.public !== true)) {
			order.push({ id: p.id, name: p.name, public: false, group: 'others' });
		}
		return order;
	}

	// Artık kaydedilmeyen (silinen, gizli yapılan, "Kaydetme"ye alınan) playlistlerin notunu ve kapağını çöpe atar.
	async removeStale(keepIds) {
		for (const [id, c] of Object.entries(this.data.cache)) {
			if (keepIds.has(id)) continue;
			for (const p of [c.path, c.coverPath]) {
				const f = p && this.app.vault.getAbstractFileByPath(p);
				if (f instanceof TFile) await this.trash(f);
			}
			delete this.data.cache[id];
		}
	}

	// Her klasör kendi içinde 001'den numaralanır; kapaklar hepsi için ortak klasörde.
	planPaths() {
		const plan = new Map();
		const usedCovers = new Set();
		for (const g of GROUPS) {
			const folder = normalizePath(this.settings[g.setting]);
			this.data.order
				.filter((o) => o.group === g.key)
				.forEach((o, i) => {
					const base = sanitizeName(o.name);
					const notePath = normalizePath(`${folder}/${pad3(i + 1)} ${base}.md`);
					let coverPath = normalizePath(`${this.settings.coverFolder}/${base}.jpg`);
					const existing = this.app.vault.getAbstractFileByPath(coverPath);
					// Kayıtlı kapak elle yeniden adlandırılmışsa (artık yoksa) bu addaki dosyayı sahiplen
					const cachedCover = this.data.cache[o.id]?.coverPath;
					const cachedGone = cachedCover && !this.app.vault.getAbstractFileByPath(cachedCover);
					const foreign = existing && cachedCover !== coverPath && !cachedGone;
					if (usedCovers.has(coverPath.toLowerCase()) || foreign) {
						coverPath = normalizePath(`${this.settings.coverFolder}/${base} (${o.id.slice(0, 4)}).jpg`);
					}
					usedCovers.add(coverPath.toLowerCase());
					plan.set(o.id, { folder, notePath, coverPath });
				});
		}
		return plan;
	}

	// Numaralar kayınca dosyalar birbirinin adını almak isteyebilir; önce geçici ada, sonra asıl ada taşınır.
	async applyRenames(visible, plan) {
		const moving = [];
		for (const pl of visible) {
			const { folder, notePath: want } = plan.get(pl.id);
			const file = this.findNote(pl, folder);
			if (!file) continue;
			if (file.path === want) {
				this.data.cache[pl.id] = Object.assign(this.data.cache[pl.id] || {}, { path: want });
				continue;
			}
			const tmp = normalizePath(`${folder}/__spotify_tmp_${pl.id}.md`);
			await this.app.fileManager.renameFile(file, tmp);
			moving.push([pl.id, tmp]);
		}
		for (const [id, tmp] of moving) {
			const p = plan.get(id);
			if (this.app.vault.getAbstractFileByPath(p.notePath)) p.notePath = p.notePath.replace(/\.md$/, ' (spotify).md');
			await this.app.fileManager.renameFile(this.app.vault.getAbstractFileByPath(tmp), p.notePath);
			this.data.cache[id] = Object.assign(this.data.cache[id] || {}, { path: p.notePath });
		}
	}

	findNote(pl, folderPath) {
		const c = this.data.cache[pl.id];
		if (c?.path) {
			const f = this.app.vault.getAbstractFileByPath(c.path);
			if (f instanceof TFile) return f;
		}
		// Kayıt yoksa (ör. eklenti yeniden kurulduysa) "NNN Playlist Adı.md" adıyla ara
		const folder = this.app.vault.getAbstractFileByPath(folderPath);
		if (!(folder instanceof TFolder)) return null;
		const claimed = new Set(Object.values(this.data.cache).map((x) => x.path));
		const base = sanitizeName(pl.name);
		for (const f of folder.children) {
			if (!(f instanceof TFile) || claimed.has(f.path)) continue;
			const m = f.name.match(/^\d{3} (.+)\.md$/);
			if (m && sanitizeName(m[1]) === base) return f;
		}
		return null;
	}

	async writePlaylist(pl, plan, force) {
		const c = this.data.cache[pl.id] || {};
		const coverUrl = pl.images?.[0]?.url || '';
		const coverPath = coverUrl ? plan.coverPath : '';
		let file = c.path ? this.app.vault.getAbstractFileByPath(c.path) : null;

		const upToDate =
			!force &&
			file instanceof TFile &&
			c.snapshotId === pl.snapshot_id &&
			c.name === pl.name &&
			c.description === pl.description &&
			c.coverUrl === coverUrl &&
			c.coverPath === coverPath &&
			c.format === NOTE_FORMAT &&
			(!coverPath || this.app.vault.getAbstractFileByPath(coverPath));

		// Kapak: ad değiştiyse dosyayı yeniden adlandır, resim değiştiyse ya da yoksa indir
		if (coverPath) {
			const old = c.coverPath && c.coverPath !== coverPath && this.app.vault.getAbstractFileByPath(c.coverPath);
			if (old instanceof TFile && !this.app.vault.getAbstractFileByPath(coverPath)) {
				await this.app.fileManager.renameFile(old, coverPath);
			}
			if (force || c.coverUrl !== coverUrl || !this.app.vault.getAbstractFileByPath(coverPath)) {
				await this.downloadCover(coverUrl, coverPath);
			}
		}

		if (upToDate) return false;

		const items = await this.fetchPlaylistItems(pl.id);
		const content = this.buildNote(pl, items, coverPath);

		if (file instanceof TFile) {
			if ((await this.app.vault.read(file)) !== content) await this.app.vault.modify(file, content);
		} else {
			let path = plan.notePath;
			if (this.app.vault.getAbstractFileByPath(path)) path = path.replace(/\.md$/, ' (spotify).md');
			file = await this.app.vault.create(path, content);
		}

		this.data.cache[pl.id] = {
			path: file.path,
			coverPath,
			coverUrl,
			snapshotId: pl.snapshot_id,
			format: NOTE_FORMAT,
			name: pl.name,
			description: pl.description,
		};
		return true;
	}

	async downloadCover(url, path) {
		const res = await requestUrl({ url, throw: false });
		if (res.status !== 200) return;
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) await this.app.vault.modifyBinary(existing, res.arrayBuffer);
		else await this.app.vault.createBinary(path, res.arrayBuffer);
	}

	async trash(file) {
		if (this.app.fileManager.trashFile) await this.app.fileManager.trashFile(file);
		else await this.app.vault.trash(file, false);
	}

	async ensureFolder(path) {
		const parts = normalizePath(path).split('/');
		let current = '';
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!this.app.vault.getAbstractFileByPath(current)) await this.app.vault.createFolder(current);
		}
	}

	// Elle eklenen notlarla aynı format:
	// kapak, boş satır, **açıklama**, boş satır, "1. **Şarkı** - Sanatçı" listesi
	buildNote(pl, items, coverPath) {
		const lines = [];
		if (coverPath) lines.push(`![[${coverPath.split('/').pop()}]]`, '');
		const description = cleanDescription(pl.description);
		lines.push(description ? `**${description}**` : '', '');

		let n = 0;
		for (const entry of items || []) {
			const t = entry.item || entry.track;
			if (!t) continue;
			const artists = t.type === 'episode' ? t.show?.name : (t.artists || []).map((a) => a.name).filter(Boolean).join(', ');
			n++;
			lines.push(artists ? `${n}. **${t.name}** - ${artists}` : `${n}. **${t.name}**`);
		}

		lines.push('');
		return lines.join('\n');
	}
};

// ---------- ayarlar ----------

class SpotifySettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		const plugin = this.plugin;
		const s = plugin.settings;
		const save = () => plugin.save();
		containerEl.empty();

		containerEl.createEl('h2', { text: 'Spotify bağlantısı' });

		new Setting(containerEl)
			.setName('Client ID')
			.setDesc('developer.spotify.com/dashboard üzerinden oluşturduğun uygulamanın Client ID değeri.')
			.addText((t) =>
				t.setPlaceholder('ör. 1a2b3c…').setValue(s.clientId).onChange(async (v) => {
					s.clientId = v.trim();
					await save();
				})
			);

		new Setting(containerEl)
			.setName('Redirect URI')
			.setDesc(`Spotify uygulama ayarlarında birebir bu adres olmalı: ${plugin.redirectUri}`)
			.addButton((b) =>
				b.setButtonText('Kopyala').onClick(() => {
					navigator.clipboard.writeText(plugin.redirectUri);
					new Notice('Redirect URI kopyalandı');
				})
			);

		const auth = plugin.data.auth;
		const status = new Setting(containerEl).setName('Hesap');
		if (auth.refreshToken) {
			status.setDesc(`Bağlı: ${auth.userName || auth.userId}`).addButton((b) =>
				b.setButtonText('Bağlantıyı kes').setWarning().onClick(async () => {
					await plugin.disconnect();
					this.display();
				})
			);
		} else {
			status.setDesc('Bağlı değil').addButton((b) =>
				b.setButtonText('Spotify’a bağlan').setCta().onClick(async () => {
					await plugin.connect();
					this.display();
				})
			);
		}

		containerEl.createEl('h2', { text: 'Kayıt' });

		new Setting(containerEl)
			.setName('Profil klasörü')
			.addText((t) =>
				t.setValue(s.folder).onChange(async (v) => {
					s.folder = normalizePath(v || DEFAULT_SETTINGS.folder);
					await save();
				})
			);

		new Setting(containerEl)
			.setName('Unyet klasörü')
			.setDesc('Herkese açık ama profilde olmayan playlistler.')
			.addText((t) =>
				t.setValue(s.unyetFolder).onChange(async (v) => {
					s.unyetFolder = normalizePath(v || DEFAULT_SETTINGS.unyetFolder);
					await save();
				})
			);

		new Setting(containerEl)
			.setName('And Others klasörü')
			.setDesc('Gizli playlistler.')
			.addText((t) =>
				t.setValue(s.othersFolder).onChange(async (v) => {
					s.othersFolder = normalizePath(v || DEFAULT_SETTINGS.othersFolder);
					await save();
				})
			);

		new Setting(containerEl)
			.setName('Kapak klasörü')
			.addText((t) =>
				t.setValue(s.coverFolder).onChange(async (v) => {
					s.coverFolder = normalizePath(v || DEFAULT_SETTINGS.coverFolder);
					await save();
				})
			);

		new Setting(containerEl)
			.setName('Güncelleme aralığı (dakika)')
			.setDesc('0 yaparsan otomatik güncelleme kapanır.')
			.addText((t) =>
				t.setValue(String(s.intervalMinutes)).onChange(async (v) => {
					const n = parseInt(v, 10);
					if (!isNaN(n) && n >= 0) {
						s.intervalMinutes = n;
						await save();
						plugin.restartTimer();
					}
				})
			);

		new Setting(containerEl)
			.setName('Obsidian açılınca güncelle')
			.addToggle((t) =>
				t.setValue(s.syncOnStartup).onChange(async (v) => {
					s.syncOnStartup = v;
					await save();
				})
			);

		new Setting(containerEl)
			.setName('Şimdi senkronize et')
			.setDesc(plugin.data.lastSync ? `Son güncelleme: ${new Date(plugin.data.lastSync).toLocaleString()}` : 'Henüz senkronize edilmedi.')
			.addButton((b) => b.setButtonText('Senkronize et').onClick(() => plugin.sync({ manual: true })))
			.addButton((b) => b.setButtonText('Hepsini baştan yaz').onClick(() => plugin.sync({ manual: true, force: true })));

		containerEl.createEl('h2', { text: 'Playlistler' });
		const order = plugin.data.order;
		if (!order.length) {
			containerEl.createEl('p', { text: 'İlk senkronizasyondan sonra herkese açık playlistlerin burada listelenir.' });
			return;
		}
		containerEl.createEl('p', {
			text: 'Spotify profildeki sırayı vermiyor. Her playlistin hangi klasöre gideceğini seç ve oklarla sırala. Değişiklikler birkaç saniye içinde dosyalara yansır.',
		});

		const changed = async () => {
			await save();
			this.display();
			plugin.scheduleSync();
		};
		// Aynı klasördeki bir önceki/sonraki playlistle yer değiştirir
		const move = (o, dir) => {
			const same = order.filter((x) => x.group === o.group);
			const k = same.indexOf(o) + dir;
			if (k < 0 || k >= same.length) return;
			const a = order.indexOf(o);
			const b = order.indexOf(same[k]);
			[order[a], order[b]] = [order[b], order[a]];
			changed();
		};
		// Klasörü değişen playlist yeni klasörün en altına geçer
		const setGroup = (o, group) => {
			order.splice(order.indexOf(o), 1);
			o.group = group;
			order.push(o);
			changed();
		};

		const sections = [
			...GROUPS.map((g) => ({ key: g.key, title: `${g.label} — ${s[g.setting]}` })),
			{ key: 'none', title: 'Kaydedilmeyenler' },
		];
		for (const sec of sections) {
			const items = order.filter((o) => o.group === sec.key);
			containerEl.createEl('h3', { text: `${sec.title} (${items.length})` });
			items.forEach((o, i) => {
				const row = new Setting(containerEl).setName(sec.key === 'none' ? o.name : `${pad3(i + 1)}  ${o.name}`);
				if (sec.key !== 'none') {
					row
						.addExtraButton((b) => b.setIcon('arrow-up').setTooltip('Yukarı').onClick(() => move(o, -1)))
						.addExtraButton((b) => b.setIcon('arrow-down').setTooltip('Aşağı').onClick(() => move(o, 1)));
				}
				row.addDropdown((d) => {
					for (const g of GROUPS) d.addOption(g.key, g.label);
					d.addOption('none', 'Kaydetme')
						.setValue(o.group)
						.onChange((v) => setGroup(o, v));
				});
			});
		}
	}
}
