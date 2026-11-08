package admin

import (
	"encoding/json"
	"testing"
)

func TestOptionalUintDistinguishesOmittedNullAndValue(t *testing.T) {
	var omitted UpdateUserReq
	if err := json.Unmarshal([]byte(`{}`), &omitted); err != nil {
		t.Fatalf("unmarshal omitted department: %v", err)
	}
	if omitted.DeptID.Set || omitted.DeptID.Value != nil {
		t.Fatalf("omitted department = %+v, want unset", omitted.DeptID)
	}

	var nullValue UpdateUserReq
	if err := json.Unmarshal([]byte(`{"dept_id":null}`), &nullValue); err != nil {
		t.Fatalf("unmarshal null department: %v", err)
	}
	if !nullValue.DeptID.Set || nullValue.DeptID.Value != nil {
		t.Fatalf("null department = %+v, want explicit nil", nullValue.DeptID)
	}

	var numeric UpdateUserReq
	if err := json.Unmarshal([]byte(`{"dept_id":12}`), &numeric); err != nil {
		t.Fatalf("unmarshal numeric department: %v", err)
	}
	if !numeric.DeptID.Set || numeric.DeptID.Value == nil || *numeric.DeptID.Value != 12 {
		t.Fatalf("numeric department = %+v, want 12", numeric.DeptID)
	}
}
