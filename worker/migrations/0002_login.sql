-- échecs de connexion par adresse IP (anti force brute)
CREATE TABLE login_failures (ip TEXT PRIMARY KEY, n INTEGER NOT NULL, since INTEGER NOT NULL);
