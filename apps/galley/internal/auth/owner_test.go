package auth

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/cristoforows/ticketIt/apps/galley/internal/postgres"
)

func TestResolveOwner_ConcurrentBootstrapRace(t *testing.T) {
	pool := postgres.NewEmptyMigratedTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	var arrived sync.WaitGroup
	arrived.Add(2)
	bothObservedEmpty := make(chan struct{})
	go func() {
		arrived.Wait()
		close(bothObservedEmpty)
	}()
	afterEmptyOwnerLookup = func() {
		arrived.Done()
		select {
		case <-bothObservedEmpty:
		case <-ctx.Done():
		}
	}
	t.Cleanup(func() { afterEmptyOwnerLookup = nil })

	type result struct {
		ownerID      int64
		bootstrapped bool
		err          error
	}
	start := make(chan struct{})
	results := make(chan result, 2)
	for range 2 {
		go func() {
			<-start
			id, b, err := ResolveOwner(ctx, pool, testIdentity.Login, testIdentity)
			results <- result{id, b, err}
		}()
	}
	close(start)

	var got [2]result
	for i := range got {
		got[i] = <-results
		if got[i].err != nil {
			t.Fatalf("ResolveOwner() error = %v", got[i].err)
		}
	}
	select {
	case <-bothObservedEmpty:
	default:
		t.Fatal("the two sign-ins did not both observe an empty owner_identities table")
	}
	if got[0].ownerID != got[1].ownerID {
		t.Errorf("owner ids = %d and %d, want the same owner", got[0].ownerID, got[1].ownerID)
	}
	if got[0].bootstrapped == got[1].bootstrapped {
		t.Errorf("bootstrapped = %v and %v, want exactly one bootstrap", got[0].bootstrapped, got[1].bootstrapped)
	}

	for _, table := range []string{"owners", "owner_identities"} {
		var n int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM `+table).Scan(&n); err != nil {
			t.Fatalf("failed to count %s: %v", table, err)
		}
		if n != 1 {
			t.Errorf("%s row count = %d, want 1", table, n)
		}
	}
}
