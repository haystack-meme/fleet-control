-- fleet-control: what fleet-server can't create itself. Run as MariaDB root on the server:
--   sudo mariadb < sql/setup.sql
-- Safe to run again: it changes nothing that already exists.
--
-- fleet-server signs in over the local socket as the MariaDB user named like the Linux user that runs it
-- (unix_socket auth, no password). This file assumes that user is `fleet`; replace it if you run the service as
-- someone else (and the database name too, if you set FLEET_DB).
--
-- The tables are not here: fleet-server creates them on every start (lib/db.js migrate()).
-- After a lost database: run this file, restart fleet-server, set the password (node bin/admin.js password <pw>),
-- then re-run `fleet-agent.js --install` on every machine and approve them again.

CREATE DATABASE IF NOT EXISTS fleet CHARACTER SET utf8mb4;
CREATE USER IF NOT EXISTS fleet@localhost IDENTIFIED VIA unix_socket;
GRANT ALL PRIVILEGES ON fleet.* TO fleet@localhost;
