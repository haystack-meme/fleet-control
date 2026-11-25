'use strict';
// Errors the API answers with: an HTTP status, a stable machine-readable code and a human-readable message, plus
// optional extra fields (e.g. can_force, logs). The JSON body is { error: message, code, ...extra }.
//
// Codes (clients may rely on these; the messages are for people and may change):
//   400 invalid            a field or parameter is wrong (the message says which)
//   400 bad_json           the request body isn't valid JSON
//   400 bad_backup         the uploaded backup is damaged, changed or not a fleet backup
//   401 unauthorized       not signed in and no valid API key
//   401 wrong_password     sign-in with a wrong password
//   403 wrong_password     password change with a wrong current password
//   403 machine_not_approved  the service's machine isn't approved
//   404 not_found          no such service, machine, version or route
//   409 name_taken         another service already has that name
//   409 running            stop the service before renaming or moving it
//   409 busy               the service is being started / stopped / restarted by another request
//   409 has_services       the machine still has services
//   409 machine_removed    that version ran on a machine that has since been removed
//   409 password_set       a password was set in the meantime (first sign-in race)
//   413 too_large          the request body is too large
//   502 machine_offline    the machine's agent isn't connected
//   502 agent_error        the agent (systemd, journalctl, ...) reported a failure
//   502 start_failed       the service stopped or crashed while starting (has logs)
//   504 agent_timeout      the agent didn't answer in time
//   504 not_ready          the service didn't become ready before the timeout (has logs)
//   504 not_stopped        the service didn't stop before the timeout
//   500 internal           a bug: see the server log
class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

module.exports = { ApiError };
