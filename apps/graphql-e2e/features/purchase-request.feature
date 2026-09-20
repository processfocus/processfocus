Feature: Purchase Request
  As a provider user
  I want to submit purchase requests
  So that I can get items approved for purchase

  Background:
    Given I am authenticated without roles
    And the database is clean

  Scenario: Retrieve todos
    When I query for todos with limit 100
    Then I should receive a list of todos
    And each todo should have required fields

  Scenario: Purchase cheap item
    # Query purchase order list before purchase to establish baseline
    Given I am authenticated with the "/Employee" role
    When I query the purchase order list

    # Finance Manager starts with no todos
    Given I am authenticated with the "/finance/Manager" role
    When I query for todos with limit 100
    Then I should have 0 todos

    # Employee starts a purchase request
    Given I am authenticated with the "/Employee" role
    When I start a purchase request for item "Chair" with value "150"
    And I wait for flow to advance

    # Employee should have no todos (manager approval pending)
    When I query for todos with limit 100
    Then I should have 0 todos

    # Finance Manager should now have 1 todo for approval
    Given I am authenticated with the "/finance/Manager" role
    When I query for todos with limit 100
    Then I should have 1 todo
    And the todo should be for step "Approve purchase request"
    And the todo summary should contain "What" with value "Chair for 150"

    # Manager completes the approval
    When I complete the first todo with manager approval
    And I wait for flow to advance

    # NodeStep auto-executes, Procurement gets purchase todo
    Given I am authenticated with the "/procurement/Manager" role
    And I wait for flow to advance
    When I query for todos with limit 100
    Then I should have 1 todo
    And the todo should be for step "Execute purchase"
    And the todo summary should contain "Purchase Order" with pattern "PO-[A-Z0-9]+"

    When I complete the first todo with purchase completion
    And I wait for flow to advance
    When I query for todos with limit 100
    Then I should have 0 todos
    And there are no more flows to advance

    # Verify the purchase order was saved to the database
    Given I am authenticated with the "/Employee" role
    Then the purchase order list should have 1 more item than before

  Scenario: Purchase expensive item
    # Employee starts a purchase request for expensive item (>= 1000)
    Given I am authenticated with the "/Employee" role
    When I start a purchase request for item "Table" with value "2500"

    # Finance Manager should have 1 todo for initial approval
    Given I am authenticated with the "/finance/Manager" role
    And I wait for flow to advance
    When I query for todos with limit 100
    Then I should have 1 todo
    And the todo should be for step "Approve purchase request"

    # Manager completes the approval
    When I complete the first todo with manager approval

    # Procurement Manager should now have 1 todo for expensive item approval
    Given I am authenticated with the "/procurement/Manager" role
    And I wait for flow to advance
    When I query for todos with limit 100
    Then I should have 1 todo
    And the todo should be for step "Approve expensive purchase request"

    # Procurement Manager completes the approval
    When I complete the first todo with procurement approval

    # NodeStep auto-executes, Procurement gets purchase todo (same user)
    And I wait for flow to advance
    When I query for todos with limit 100
    Then I should have 1 todo
    And the todo should be for step "Execute purchase"
    And the todo summary should contain "Purchase Order" with pattern "PO-[A-Z0-9]+"

    When I complete the first todo with purchase completion
    And I wait for flow to advance

    # Procurement Manager should have no more todos
    When I query for todos with limit 100
    Then I should have 0 todos
    And there are no more flows to advance

  Scenario: Purchase expensive item with websocket todo notifications
    # Setup: authenticate 3 users as provider users (for unique userIds) and subscribe each
    # Using email-based auth ensures each user gets a unique userId for separate subscription channels
    Given "employee" is authenticated as provider user "employee@example.com"
    And "employee" subscribes to todo updates
    And "employee" subscribes to process updates
    And "employee" subscribes to execution updates
    Given "finance_manager" is authenticated as provider user "finance-manager@example.com"
    And "finance_manager" subscribes to todo updates
    And "finance_manager" subscribes to process updates
    Given "procurement_manager" is authenticated as provider user "procurement-manager@example.com"
    And "procurement_manager" subscribes to todo updates
    And "procurement_manager" subscribes to process updates

    # Employee starts expensive purchase
    Given I switch to user "employee"
    When I start a purchase request for item "Laptop" with value "2500"
    And I wait for flow to advance

    # Employee should see process update with activeInstances = 1
    # Authorization: Only users with /Employee role can see Purchase Request process
    # (because the process start step has role /Employee)
    Then "employee" should see a process update for "Purchase Request" with 1 active instance

    # Managers should not see process updates (they don't have /Employee role)
    And "finance_manager" should not see any process updates
    And "procurement_manager" should not see any process updates

    # Employee should see new execution with status "Running"
    # Authorization: Only the user who started the execution can view it
    And "employee" should see a new execution for "Purchase Request"

    # Finance Manager should see todo via websocket with summary
    Then "finance_manager" should see a todo for step "Approve purchase request" with summary "What" containing "Laptop for 2500"
    And "employee" should not see any todos
    And "procurement_manager" should not see any todos
    Given I clear all subscription events

    # Finance Manager approves
    Given I switch to user "finance_manager"
    When I query for todos with limit 100
    And I complete the first todo with manager approval
    And I wait for flow to advance

    # Procurement Manager should now see todo via websocket with summary (includes approver name)
    Then "procurement_manager" should see a todo for step "Approve expensive purchase request" with summary "What" containing "Laptop for 2500"
    And "employee" should not see any todos
    And "finance_manager" should not see any todos

    # Procurement Manager approves
    Given I switch to user "procurement_manager"
    When I query for todos with limit 100
    And I complete the first todo with procurement approval
    And I wait for flow to advance

    # NodeStep auto-executes, Procurement should see purchase todo
    And I wait for flow to advance
    Then "procurement_manager" should see a todo for step "Execute purchase" with summary "Purchase Order" containing pattern

    Given I switch to user "procurement_manager"
    When I query for todos with limit 100
    And I complete the first todo with purchase completion
    And I wait for flow to advance
    And there are no more flows to advance
