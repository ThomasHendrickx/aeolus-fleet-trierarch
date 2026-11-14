package plugin

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestPermissionAnswersAreTakenBeforeHandOverOrKeptForTheNextTurn(t *testing.T) {
	for _, take := range []bool{true, false} {
		t.Run(fmt.Sprint(take), func(t *testing.T) {
			var receives, acks, handled atomic.Int32
			fleet := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/api/v1/ship/pushReceive":
					if receives.Add(1) == 1 {
						fmt.Fprint(w, `{"deliveries":[{"deliveryId":"dlv_01m6jyczpnpp5c0vxh54c966cw","messageId":"msg_01m6jyczpnpp5c0vxh54c966cx","senderShipId":"shp_01m6jyczpnpp5c0vxh54c966cz","senderName":"person","contentType":"application/vnd.aeolus.answer+json","payload":"{\"questionId\":\"question-1\",\"option\":1}","inReplyTo":"msg_01m6jyczpnpp5c0vxh54c966cv"}]}`)
					} else {
						fmt.Fprint(w, `{"deliveries":[]}`)
					}
				case "/api/v1/ship/ack":
					acks.Add(1)
					fmt.Fprint(w, `{}`)
				case "/api/v1/ship/handled":
					handled.Add(1)
					fmt.Fprint(w, `{}`)
				case "/api/v1/ship/handed":
					fmt.Fprint(w, `{"state":"handed"}`)
				case "/api/v1/ship/turn":
					fmt.Fprint(w, `{}`)
				default:
					t.Errorf("unexpected request %s", r.URL.Path)
					http.Error(w, "unexpected", 404)
				}
			}))
			defer fleet.Close()
			p := thePlugin(t)
			folder := t.TempDir()
			if err := p.WriteIdentity(folder, Identity{FleetURL: fleet.URL, ShipID: scout, ShipName: "scout"}, "test-crew"); err != nil {
				t.Fatal(err)
			}
			reply, err := p.PermissionReply(context.Background(), folder)
			if err != nil {
				t.Fatal(err)
			}
			var delivery struct{ DeliveryID, SenderShipID, Payload string }
			if err := json.Unmarshal([]byte(reply), &delivery); err != nil {
				t.Fatal(err)
			}
			if delivery.DeliveryID != "dlv_01m6jyczpnpp5c0vxh54c966cw" || !strings.Contains(delivery.Payload, `"option":1`) {
				t.Fatalf("reply = %s", reply)
			}
			if err := p.FinishPermissionReply(context.Background(), folder, delivery.DeliveryID, take); err != nil {
				t.Fatal(err)
			}
			if acks.Load() != 1 {
				t.Fatalf("acks = %d, want 1", acks.Load())
			}
			if take && handled.Load() != 1 {
				t.Fatalf("handled = %d, want 1", handled.Load())
			}
			again, err := p.PermissionReply(context.Background(), folder)
			if err != nil || strings.TrimSpace(again) != "{}" {
				t.Fatalf("next reply %q, error %v", again, err)
			}
			line, ok := p.HandOverLine(folder)
			if ok == take {
				t.Fatalf("hand-over = %q (%v), taken %v", line, ok, take)
			}
		})
	}
}
