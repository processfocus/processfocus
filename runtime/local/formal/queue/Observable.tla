---------------------------- MODULE Observable ----------------------------
EXTENDS Supervised

(* #3671: independent supervisor-side reads. A failed read is unavailable,
   never an empty successful snapshot. Sampling is not dispatch fairness and
   does not promote any job. Finite sets abstract counts/oldest identity; real
   wall-clock ages and rate limiting are checked at the Turso/worker boundary. *)
VARIABLE snapshot, sample
ovars == <<svars, snapshot, sample>>
StateOf(j) == IF j \in failed THEN "terminal"
              ELSE IF j \notin rows THEN "completed"
              ELSE IF lease[j] > 0 THEN "processing"
              ELSE IF attempts[j] = MaxAttempts THEN "recovery-needed"
              ELSE IF delay[j] > 0 THEN "delayed"
              ELSE "eligible"
Unavailable == [status |-> "unavailable", states |-> [j \in Jobs |-> "unknown"]]
Observe == /\ snapshot' = [status |-> "available", states |-> [j \in Jobs |-> StateOf(j)]]
           /\ sample' = 1 - sample /\ UNCHANGED svars
ReadError == /\ snapshot' = Unavailable
             /\ sample' = 1 - sample /\ UNCHANGED svars
ONext == (SNext /\ UNCHANGED <<snapshot, sample>>) \/ Observe \/ ReadError
OSpec == SInit /\ snapshot = Unavailable /\ sample = 0
         /\ [][ONext]_ovars /\ WF_ovars(Observe)
         /\ WF_svars(SSelect) /\ WF_svars(SClaim) /\ WF_svars(SHandle)
         /\ WF_svars(SFinish) /\ WF_svars(STick) /\ WF_svars(SMaintain)
         /\ WF_svars(SRefill) /\ WF_svars(SStartup)
ObservationTypeOK == snapshot = Unavailable \/
  snapshot \in [status : {"available"}, states : [Jobs -> {"eligible", "delayed", "processing",
                        "recovery-needed", "terminal", "completed"}]]
ObservationProgress == []<>(snapshot.status = "available")
WaitingVisible == \A j \in Observed :
  (<>[](StateOf(j) = "eligible")) =>
    []<>(snapshot.status = "available" /\ snapshot.states[j] = "eligible")
=============================================================================
