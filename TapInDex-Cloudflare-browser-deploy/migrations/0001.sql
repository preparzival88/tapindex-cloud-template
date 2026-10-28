PRAGMA foreign_keys=ON;
CREATE TABLE profiles(id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE access(owner TEXT NOT NULL REFERENCES profiles(id), viewer TEXT NOT NULL REFERENCES profiles(id), approved INTEGER NOT NULL DEFAULT 0, collection INTEGER NOT NULL DEFAULT 0, wishlist INTEGER NOT NULL DEFAULT 0, trades INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(owner,viewer), CHECK(owner<>viewer));
CREATE INDEX access_viewer ON access(viewer);
CREATE TABLE feeds(owner TEXT NOT NULL REFERENCES profiles(id), kind TEXT NOT NULL, epoch INTEGER NOT NULL DEFAULT 0, snapshot TEXT, sequence INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(owner,kind));
CREATE TABLE snapshots(sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, owner TEXT NOT NULL REFERENCES profiles(id), kind TEXT NOT NULL, epoch INTEGER NOT NULL, count INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'staging', created INTEGER NOT NULL, published TEXT);
CREATE INDEX snapshots_owner ON snapshots(owner,kind,status);
CREATE TABLE chunks(snapshot TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE, part INTEGER NOT NULL, hash TEXT NOT NULL, bytes INTEGER NOT NULL, count INTEGER NOT NULL, ready INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(snapshot,part));
CREATE TABLE limits(actor TEXT NOT NULL, minute INTEGER NOT NULL, calls INTEGER NOT NULL, PRIMARY KEY(actor,minute));
