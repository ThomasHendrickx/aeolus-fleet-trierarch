package reconciler

import (
	"slices"
	"testing"

	"github.com/ThomasHendrickx/aeolus-fleet-trierarch/go/internal/config"
)

const skipPermissions = "--dangerously-skip-permissions"

func aFolderRequest(shipID string) Request {
	request := aRequest(shipID)
	request.Settings.Workspace = Workspace{Kind: "folder", Name: "notes"}
	return request
}

func TestARequestWithNoHarnessOnAMachineOfferingNoneIsGivenBack(t *testing.T) {
	request := aRequest(scout)
	request.Settings.Harness = ""
	context := aContext(request)
	context.Harnesses = nil

	_, actions := Reconcile(Empty(), context)

	assertActions(t, actions, Action{Kind: GiveBack, ShipID: scout, SettingsVersion: 1, Reason: "harness: This trierarch offers no harness"})
}

func TestARequestInAFolderNotConfiguredIsGivenBackWithWhy(t *testing.T) {
	request := aFolderRequest(scout)
	request.Settings.Workspace.Name = "diary"

	_, actions := Reconcile(Empty(), aContext(request))

	assertActions(t, actions, Action{Kind: GiveBack, ShipID: scout, SettingsVersion: 1, Reason: "workspace.name: This trierarch offers no folder diary"})
}

func TestARequestInAFolderAnotherShipCrewsIsGivenBack(t *testing.T) {
	crewing := anEntry(lookout, "running")
	crewing.Workspace = Workspace{Kind: "folder", Name: "notes"}

	keeping := aFolderRequest(lookout)
	keeping.Status = status("running")
	context := aContext(aFolderRequest(scout), keeping)
	context.Observed.Sessions = running(lookout)

	_, actions := Reconcile(withEntries(crewing), context)

	assertActions(t, actions, Action{Kind: GiveBack, ShipID: scout, SettingsVersion: 1, Reason: "workspace.name: The folder notes crews " + lookout + " already: one folder crews one ship"})
}

func TestAShipsOwnFolderDoesNotCountAsCrewedByAnother(t *testing.T) {
	own := anEntry(scout, "running")
	own.Workspace = Workspace{Kind: "folder", Name: "notes"}
	request := aFolderRequest(scout)
	request.SettingsVersion = 2

	_, actions := Reconcile(withEntries(own), aContext(request))

	assertActions(t, actions, Action{Kind: Stop, ShipID: scout}, Action{Kind: Crew, ShipID: scout, IsResumed: true})
}

func TestARequestInARepositoryTheHarnessDoesNotTrustIsGivenBackNamingHowToTrustIt(t *testing.T) {
	context := aContext(aRequest(scout))
	context.Trusted = map[string]Trust{"claude-code": {}}

	_, actions := Reconcile(Empty(), context)

	assertActions(t, actions, Action{Kind: GiveBack, ShipID: scout, SettingsVersion: 1, Reason: "workspace.main.repository: claude-code does not trust the repository aeolus-fleet: add it with aeolus-trierarch init, which trusts it"})
}

func TestARequestInAFolderTheHarnessDoesNotTrustIsGivenBackNamingHowToTrustIt(t *testing.T) {
	context := aContext(aFolderRequest(scout))
	context.Trusted = map[string]Trust{"claude-code": {Repositories: []string{"aeolus-fleet"}}}

	_, actions := Reconcile(Empty(), context)

	assertActions(t, actions, Action{Kind: GiveBack, ShipID: scout, SettingsVersion: 1, Reason: "workspace.name: claude-code does not trust the folder notes: add it with aeolus-trierarch init, which trusts it"})
}

func TestAHarnessWithNothingReadOfItTrustsNothing(t *testing.T) {
	context := aContext(aRequest(scout))
	context.Trusted = map[string]Trust{}

	_, actions := Reconcile(Empty(), context)

	assertActions(t, actions, Action{Kind: GiveBack, ShipID: scout, SettingsVersion: 1, Reason: "workspace.main.repository: claude-code does not trust the repository aeolus-fleet: add it with aeolus-trierarch init, which trusts it"})
}

func TestARequestWhoseFlagWaitsOnAOneTimeQuestionIsGivenBackNamingHowToAcceptIt(t *testing.T) {
	context := aContext(aRequest(scout))
	context.Configuration["claude-code"] = config.Harness{Flags: []string{skipPermissions}, Options: map[string]config.Option{}}
	context.Trusted["claude-code"] = Trust{Repositories: []string{"aeolus-fleet"}, UnacceptedFlags: []string{skipPermissions}}

	_, actions := Reconcile(Empty(), context)

	assertActions(t, actions, Action{Kind: GiveBack, ShipID: scout, SettingsVersion: 1, Reason: "harness: claude-code still asks to accept " + skipPermissions + ": accept it with aeolus-trierarch init"})
}

func TestAnUnacceptedFlagOfAnOptionValueThatIsPickedOrDefaultedRefusesButNotOneNotLaunched(t *testing.T) {
	option := config.Option{Values: map[string][]string{"fast": {skipPermissions}, "slow": {}}, Default: "slow"}
	context := aContext(aRequest(scout))
	context.Configuration["claude-code"] = config.Harness{Flags: []string{}, Options: map[string]config.Option{"speed": option}}
	context.Options = map[string]map[string][]string{"claude-code": {"speed": {"fast", "slow"}}}
	context.Trusted["claude-code"] = Trust{Repositories: []string{"aeolus-fleet"}, UnacceptedFlags: []string{skipPermissions}}

	_, defaulted := Reconcile(Empty(), context)

	assertActions(t, defaulted, Action{Kind: Crew, ShipID: scout})

	picking := aRequest(scout)
	picking.Settings.Options = map[string]string{"speed": "fast"}
	context.Requests = []Request{picking}

	_, picked := Reconcile(Empty(), context)

	assertActions(t, picked, Action{Kind: GiveBack, ShipID: scout, SettingsVersion: 1, Reason: "harness: claude-code still asks to accept " + skipPermissions + ": accept it with aeolus-trierarch init"})
}

func TestANewSettingsVersionInAPlaceNoLongerTrustedIsGivenBack(t *testing.T) {
	request := aRequest(scout)
	request.SettingsVersion = 2
	entry := anEntry(scout, "running")
	context := aContext(request)
	context.Trusted = map[string]Trust{"claude-code": {}}

	_, actions := Reconcile(withEntries(entry), context)

	given := entry
	assertActions(t, actions, Action{Kind: GiveBack, ShipID: scout, SettingsVersion: 2, Reason: "workspace.main.repository: claude-code does not trust the repository aeolus-fleet: add it with aeolus-trierarch init, which trusts it", Entry: &given})
}

func TestARequestNamingAServerTheHarnessOffersIsCrewed(t *testing.T) {
	request := aRequest(scout)
	request.Settings.McpServers = []string{"company-graph"}
	context := aContext(request)
	context.McpServers = map[string][]string{"claude-code": {"company-graph"}}

	_, actions := Reconcile(Empty(), context)

	assertActions(t, actions, Action{Kind: Crew, ShipID: scout})
}

func TestARequestNamingAServerNotOfferedIsGivenBackWithMcpServersAndTheServersName(t *testing.T) {
	request := aRequest(scout)
	request.Settings.McpServers = []string{"company-graph", "notes"}
	context := aContext(request)
	context.McpServers = map[string][]string{"claude-code": {"company-graph"}}

	_, actions := Reconcile(Empty(), context)

	assertActions(t, actions, Action{Kind: GiveBack, ShipID: scout, SettingsVersion: 1, Reason: "mcpServers: This trierarch offers no MCP server notes to claude-code"})
}

func TestARequestNamingAServerWhenNoneIsOfferedIsGivenBack(t *testing.T) {
	request := aRequest(scout)
	request.Settings.McpServers = []string{"company-graph"}

	_, actions := Reconcile(Empty(), aContext(request))

	assertActions(t, actions, Action{Kind: GiveBack, ShipID: scout, SettingsVersion: 1, Reason: "mcpServers: This trierarch offers no MCP server company-graph to claude-code"})
}

func TestAFinalRequestNamingAServerNotOfferedIsGivenBackToo(t *testing.T) {
	request := aRequest(scout)
	request.IsFinal = true
	request.Settings.McpServers = []string{"company-graph"}

	_, actions := Reconcile(Empty(), aContext(request))

	assertActions(t, actions, Action{Kind: GiveBack, ShipID: scout, SettingsVersion: 1, Reason: "mcpServers: This trierarch offers no MCP server company-graph to claude-code"})
}

func TestARequestNamingNoServerNeedsNone(t *testing.T) {
	_, actions := Reconcile(Empty(), aContext(aRequest(scout)))

	assertActions(t, actions, Action{Kind: Crew, ShipID: scout})
}

func TestACrewedShipKeepsTheServersItsRequestNames(t *testing.T) {
	request := aRequest(scout)
	request.Settings.McpServers = []string{"company-graph"}
	context := aContext(request)
	context.McpServers = map[string][]string{"claude-code": {"company-graph"}}

	next, _ := Reconcile(Empty(), context)

	if got := next.Entries[scout].McpServers; !slices.Equal(got, []string{"company-graph"}) {
		t.Fatalf("the entry's MCP servers = %v, want [company-graph]", got)
	}
}

func TestANewSettingsVersionCrewsTheShipWithTheServersItNames(t *testing.T) {
	entry := anEntry(scout, "running")
	entry.McpServers = []string{"company-graph"}
	request := aRequest(scout)
	request.SettingsVersion = 2
	context := aContext(request)
	context.Observed.Sessions = running(scout)
	context.McpServers = map[string][]string{"claude-code": {"company-graph"}}

	next, _ := Reconcile(withEntries(entry), context)

	if got := next.Entries[scout].McpServers; len(got) != 0 {
		t.Fatalf("the entry's MCP servers = %v, want none", got)
	}
}
