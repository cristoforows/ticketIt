package httpapi

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"sort"
	"strconv"
	"time"
)

// The key and the Round id are not hashed: a replay is the same key carrying the same payload.
func roundEventPayloadHash(eventType RoundEventType, claimEpoch int, occurredAt time.Time, data []byte) ([]byte, error) {
	decoded, err := decodeCanonicalValue(data)
	if err != nil {
		return nil, err
	}
	var document bytes.Buffer
	writeCanonicalValue(&document, map[string]any{
		"claimEpoch": json.Number(strconv.Itoa(claimEpoch)),
		"data":       decoded,
		"occurredAt": occurredAt.UTC().Format(time.RFC3339Nano),
		"type":       string(eventType),
	})
	sum := sha256.Sum256(document.Bytes())
	return sum[:], nil
}

func decodeCanonicalValue(raw []byte) (any, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	if err := decoder.Decode(&json.RawMessage{}); !errors.Is(err, io.EOF) {
		return nil, errors.New("more than one JSON value")
	}
	return value, nil
}

func writeCanonicalValue(out *bytes.Buffer, value any) {
	switch v := value.(type) {
	case nil:
		out.WriteString("null")
	case bool:
		out.WriteString(strconv.FormatBool(v))
	case json.Number:
		out.WriteString(v.String())
	case string:
		encoded, _ := json.Marshal(v)
		out.Write(encoded)
	case []any:
		out.WriteByte('[')
		for i, element := range v {
			if i > 0 {
				out.WriteByte(',')
			}
			writeCanonicalValue(out, element)
		}
		out.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(v))
		for key := range v {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		out.WriteByte('{')
		for i, key := range keys {
			if i > 0 {
				out.WriteByte(',')
			}
			encoded, _ := json.Marshal(key)
			out.Write(encoded)
			out.WriteByte(':')
			writeCanonicalValue(out, v[key])
		}
		out.WriteByte('}')
	}
}
