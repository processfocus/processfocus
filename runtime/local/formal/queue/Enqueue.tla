------------------------------ MODULE Enqueue ------------------------------
EXTENDS Naturals, FiniteSets

(* Enqueue extraction from PR #3664, updated for #3666. Each request is a
   fresh physical ID. Return inside a transaction and successful savepoint
   return are provisional. Only the outermost Commit permits an external
   acceptance announcement. AnnounceBeforeCommit=TRUE retains the historical
   producer-log counterexamples, not the implemented reporting boundary.
   Abort abstracts insert/transaction/commit failure or pre-commit crash.
   Consumption may precede the producer observing success. *)
CONSTANTS Requests, Transactional, AnnounceBeforeCommit
ASSUME /\ Transactional \subseteq Requests
       /\ AnnounceBeforeCommit \in BOOLEAN

VARIABLES phase, staged, rows, committed, returned, announced, consumed,
          stagedReports, savepointReturned
vars == <<phase, staged, rows, committed, returned, announced, consumed,
          stagedReports, savepointReturned>>

Init ==
    /\ phase = [r \in Requests |-> "new"]
    /\ staged = {}
    /\ rows = {}
    /\ committed = {}
    /\ returned = {}
    /\ announced = {}
    /\ consumed = {}
    /\ stagedReports = {}
    /\ savepointReturned = {}

Insert(r) ==
    /\ phase[r] = "new"
    /\ phase' = [phase EXCEPT ![r] = "inserted"]
    /\ IF r \in Transactional
          THEN /\ staged' = staged \cup {r}
               /\ UNCHANGED <<rows, committed>>
          ELSE /\ rows' = rows \cup {r}
               /\ committed' = committed \cup {r}
               /\ UNCHANGED staged
    /\ UNCHANGED <<returned, announced, consumed, stagedReports, savepointReturned>>

InsertError(r) ==
    /\ phase[r] = "new"
    /\ phase' = [phase EXCEPT ![r] = "error"]
    /\ UNCHANGED <<staged, rows, committed, returned, announced, consumed,
                    stagedReports, savepointReturned>>

Return(r) ==
    /\ phase[r] = "inserted"
    /\ phase' = [phase EXCEPT ![r] = "returned"]
    /\ returned' = returned \cup {r}
    /\ stagedReports' = IF r \in Transactional
                           THEN stagedReports \cup {r} ELSE stagedReports
    /\ UNCHANGED <<staged, rows, committed, announced, consumed, savepointReturned>>

(* A successful nested transaction does not publish its buffered acceptance. *)
SavepointReturn(r) ==
    /\ r \in staged \cap returned
    /\ r \notin savepointReturned
    /\ savepointReturned' = savepointReturned \cup {r}
    /\ UNCHANGED <<phase, staged, rows, committed, returned, announced, consumed,
                    stagedReports>>

Commit(r) ==
    /\ r \in staged
    /\ phase[r] = "returned"
    /\ phase' = [phase EXCEPT ![r] = "committed"]
    /\ staged' = staged \ {r}
    /\ rows' = rows \cup {r}
    /\ committed' = committed \cup {r}
    /\ UNCHANGED <<returned, announced, consumed, stagedReports, savepointReturned>>

Abort(r) ==
    /\ r \in staged
    /\ phase' = [phase EXCEPT ![r] = "aborted"]
    /\ staged' = staged \ {r}
    /\ UNCHANGED <<rows, committed, returned, announced, consumed,
                    stagedReports, savepointReturned>>

(* Lost responses never compensate by deleting accepted work. *)
LoseResponse(r) ==
    /\ r \in committed
    /\ phase[r] \in {"inserted", "returned", "committed"}
    /\ phase' = [phase EXCEPT ![r] = "error"]
    /\ UNCHANGED <<staged, rows, committed, returned, announced, consumed,
                    stagedReports, savepointReturned>>

Announce(r) ==
    /\ r \in returned \ announced
    /\ phase[r] \in {"returned", "committed"}
    /\ AnnounceBeforeCommit \/ r \in committed
    /\ announced' = announced \cup {r}
    /\ UNCHANGED <<phase, staged, rows, committed, returned, consumed,
                    stagedReports, savepointReturned>>

Consume(r) ==
    /\ r \in rows
    /\ rows' = rows \ {r}
    /\ consumed' = consumed \cup {r}
    /\ UNCHANGED <<phase, staged, committed, returned, announced,
                    stagedReports, savepointReturned>>

Next == \E r \in Requests :
    Insert(r) \/ InsertError(r) \/ Return(r) \/ SavepointReturn(r) \/ Commit(r)
    \/ Abort(r) \/ LoseResponse(r) \/ Announce(r) \/ Consume(r)
Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ phase \in [Requests ->
         {"new", "inserted", "returned", "committed", "aborted", "error"}]
    /\ staged \subseteq Transactional
    /\ rows \subseteq Requests
    /\ committed \subseteq Requests
    /\ returned \subseteq Requests
    /\ announced \subseteq returned
    /\ consumed \subseteq Requests
    /\ stagedReports \subseteq Transactional \cap returned
    /\ savepointReturned \subseteq stagedReports
    /\ staged \cap committed = {}
    /\ rows \cap consumed = {}

CommittedWorkAccountedFor == committed = rows \cup consumed
AnnouncementsAreDurable == announced \subseteq committed
ReturnsAreDurable == returned \subseteq rows \cup consumed
NoRolledBackAnnouncement == \A r \in announced : phase[r] # "aborted"
=============================================================================
