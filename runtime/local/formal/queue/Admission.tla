----------------------------- MODULE Admission -----------------------------
EXTENDS Integers

(* Producer admission after #3667. One arbitrary request is enough to check
   the boundary; Lifecycle retains the old pre-validation counterexamples.
   SafeMax bounds safe-integer conversion; non-integral/non-finite values are
   abstracted as distinct invalid inputs. Future time is one abstract tick. *)
SafeMax == 7
(* Negative sentinels avoid heterogeneous sets in TLC: -2 is fractional,
   -3 is non-finite, -4 is omitted. Delay -2 represents non-finite. *)
Retries == {-4, -3, -2, -1, 0, 1, SafeMax - 1, SafeMax, SafeMax + 1}
Delays == {-2, -1, 0, 1}
Queues == {"main", "custom", "separate", "absent", "invalid-owner"}
Declared == {"main", "custom", "separate"}

VARIABLES request, status, budget, time, claimed
vars == <<request, status, budget, time, claimed>>

ValidRetries(r) == (r >= 0 /\ r < SafeMax) \/ r = -4
ValidDelay(d) == d \in {0, 1}
ValidRequest == ValidRetries(request.retries) /\ ValidDelay(request.delay)
                /\ request.queue \in Declared
Budget(r) == IF r = -4 THEN 5 ELSE r + 1

Init ==
    /\ request \in [retries : Retries, delay : Delays, queue : Queues]
    /\ status = "pending"
    /\ budget = 0
    /\ time = 0
    /\ claimed = FALSE

Admit ==
    /\ status = "pending"
    /\ IF ValidRequest
       THEN /\ status' = "persisted"
            /\ budget' = Budget(request.retries)
       ELSE /\ status' = "rejected"
            /\ UNCHANGED budget
    /\ UNCHANGED <<request, time, claimed>>

Tick ==
    /\ time = 0
    /\ time' = 1
    /\ UNCHANGED <<request, status, budget, claimed>>

Claim ==
    /\ status = "persisted"
    /\ request.delay <= time
    /\ ~claimed
    /\ claimed' = TRUE
    /\ UNCHANGED <<request, status, budget, time>>

Next == Admit \/ Tick \/ Claim
Spec == Init /\ [][Next]_vars /\ WF_vars(Admit)
        /\ WF_vars(Tick) /\ WF_vars(Claim)

AcceptedAreProcessable == status = "persisted" =>
    ValidRequest /\ budget \in 1..SafeMax
    /\ (request.retries = 0 => budget = 1)
    /\ (request.retries = -4 => budget = 5)
InvalidNeverPersisted == ~ValidRequest => status # "persisted"
NoEarlyClaim == claimed => status = "persisted" /\ request.delay <= time
AdmissionDecided == <>(status # "pending")
ValidEventuallyClaimed == ValidRequest => <>claimed
=============================================================================
