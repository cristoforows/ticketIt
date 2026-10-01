package httpapi

import (
	"bytes"
	"encoding/hex"
	"testing"
	"time"
)

func canonicalJSON(raw []byte) ([]byte, error) {
	decoded, err := decodeCanonicalValue(raw)
	if err != nil {
		return nil, err
	}
	var out bytes.Buffer
	writeCanonicalValue(&out, decoded)
	return out.Bytes(), nil
}

func TestCanonicalJSON_SortsKeysAtEveryDepthAndKeepsArrayOrder(t *testing.T) {
	got, err := canonicalJSON([]byte(` { "b" : [ 3, 1, {"z":1,"a":[true,null]} ], "a" : {"y":"1", "x":2} } `))
	if err != nil {
		t.Fatal(err)
	}
	want := `{"a":{"x":2,"y":"1"},"b":[3,1,{"a":[true,null],"z":1}]}`
	if string(got) != want {
		t.Fatalf("canonicalJSON = %s, want %s", got, want)
	}
}

func TestCanonicalJSON_KeepsNumbersExactlyAsWritten(t *testing.T) {
	for _, number := range []string{"9007199254740993", "12345678901234567890123", "1.10", "-0", "1E2", "0.1000000000000000055511151231257827"} {
		got, err := canonicalJSON([]byte(`{"n":` + number + `}`))
		if err != nil {
			t.Fatal(err)
		}
		if want := `{"n":` + number + `}`; string(got) != want {
			t.Errorf("canonicalJSON = %s, want %s", got, want)
		}
	}
}

func TestCanonicalJSON_RejectsWhatIsNotOneJSONValue(t *testing.T) {
	for _, raw := range []string{``, `{`, `{"a":1} {"b":2}`, `{"a":1}x`, `nul`} {
		if got, err := canonicalJSON([]byte(raw)); err == nil {
			t.Errorf("canonicalJSON(%q) = %s, want an error", raw, got)
		}
	}
}

func TestCanonicalJSON_EquivalentEscapesCanonicaliseAlike(t *testing.T) {
	a, _ := canonicalJSON([]byte(`{"k":"A\u00e9"}`))
	b, _ := canonicalJSON([]byte(`{"k":"Aé"}`))
	if !bytes.Equal(a, b) || len(a) == 0 {
		t.Fatalf("canonical forms differ: %s vs %s", a, b)
	}
}

var hashOccurredAt = time.Date(2026, 10, 1, 12, 0, 0, 500_000_000, time.UTC)

func mustHash(t *testing.T, eventType RoundEventType, epoch int, occurredAt time.Time, data string) string {
	t.Helper()
	sum, err := roundEventPayloadHash(eventType, epoch, occurredAt, []byte(data))
	if err != nil {
		t.Fatal(err)
	}
	if len(sum) != 32 {
		t.Fatalf("hash length = %d, want 32", len(sum))
	}
	return hex.EncodeToString(sum)
}

func TestRoundEventPayloadHash_IgnoresKeyOrderAndWhitespaceInData(t *testing.T) {
	base := mustHash(t, RoundEventExecutionStarted, 1, hashOccurredAt, `{"a":1,"b":{"c":[1,2],"d":"x"}}`)
	for _, data := range []string{
		`{"b":{"d":"x","c":[1,2]},"a":1}`,
		"{ \"a\" : 1,\n \"b\" : { \"c\" : [ 1, 2 ], \"d\" : \"x\" } }",
	} {
		if got := mustHash(t, RoundEventExecutionStarted, 1, hashOccurredAt, data); got != base {
			t.Errorf("data %s hashed to %s, want %s", data, got, base)
		}
	}
}

func TestRoundEventPayloadHash_NormalisesTheInstantToUTC(t *testing.T) {
	base := mustHash(t, RoundEventExecutionStarted, 1, hashOccurredAt, `{}`)
	offset := time.FixedZone("UTC+8", 8*3600)
	for name, at := range map[string]time.Time{
		"other offset":                  hashOccurredAt.In(offset),
		"parsed with an offset":         mustParseRFC3339(t, "2026-10-01T20:00:00.5+08:00"),
		"parsed with trailing zeros":    mustParseRFC3339(t, "2026-10-01T12:00:00.500000000Z"),
		"parsed with a negative offset": mustParseRFC3339(t, "2026-10-01T07:00:00.5-05:00"),
	} {
		if got := mustHash(t, RoundEventExecutionStarted, 1, at, `{}`); got != base {
			t.Errorf("%s hashed to %s, want %s", name, got, base)
		}
	}
}

func mustParseRFC3339(t *testing.T, s string) time.Time {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func TestRoundEventPayloadHash_DetectsEveryDifference(t *testing.T) {
	base := mustHash(t, RoundEventExecutionStarted, 1, hashOccurredAt, `{"a":1}`)
	seen := map[string]string{base: "base"}
	for name, got := range map[string]string{
		"claim epoch":             mustHash(t, RoundEventExecutionStarted, 2, hashOccurredAt, `{"a":1}`),
		"instant, one nanosecond": mustHash(t, RoundEventExecutionStarted, 1, hashOccurredAt.Add(time.Nanosecond), `{"a":1}`),
		"instant, one second":     mustHash(t, RoundEventExecutionStarted, 1, hashOccurredAt.Add(time.Second), `{"a":1}`),
		"data value":              mustHash(t, RoundEventExecutionStarted, 1, hashOccurredAt, `{"a":2}`),
		"data key":                mustHash(t, RoundEventExecutionStarted, 1, hashOccurredAt, `{"b":1}`),
		"data extra key":          mustHash(t, RoundEventExecutionStarted, 1, hashOccurredAt, `{"a":1,"b":1}`),
		"data number text":        mustHash(t, RoundEventExecutionStarted, 1, hashOccurredAt, `{"a":1.0}`),
		"data 2^53+1":             mustHash(t, RoundEventExecutionStarted, 1, hashOccurredAt, `{"a":9007199254740993}`),
		"data 2^53":               mustHash(t, RoundEventExecutionStarted, 1, hashOccurredAt, `{"a":9007199254740992}`),
		"data string vs number":   mustHash(t, RoundEventExecutionStarted, 1, hashOccurredAt, `{"a":"1"}`),
		"data array order":        mustHash(t, RoundEventExecutionStarted, 1, hashOccurredAt, `{"a":[1,2]}`),
		"event type":              mustHash(t, RoundEventType("progress"), 1, hashOccurredAt, `{"a":1}`),
	} {
		if previous, dup := seen[got]; dup {
			t.Errorf("%s hashed like %s", name, previous)
		}
		seen[got] = name
	}
}

func TestRoundEventPayloadHash_PinsTheCanonicalEncoding(t *testing.T) {
	// SHA-256 of {"claimEpoch":1,"data":{"engineReference":"controlled:x"},"occurredAt":"2026-10-01T12:00:00.5Z","type":"execution_started"}
	const want = "4e2e62f021f506d3ddbd413795fe4e52853a178e9806185472a0bc42045ceaff"
	got := mustHash(t, RoundEventExecutionStarted, 1, hashOccurredAt, `{"engineReference":"controlled:x"}`)
	if got != want {
		t.Fatalf("hash = %s, want %s", got, want)
	}
}

func TestRoundEventPayloadHash_RejectsInvalidData(t *testing.T) {
	if sum, err := roundEventPayloadHash(RoundEventExecutionStarted, 1, hashOccurredAt, []byte(`{`)); err == nil {
		t.Fatalf("hash of invalid JSON = %x, want an error", sum)
	}
}
