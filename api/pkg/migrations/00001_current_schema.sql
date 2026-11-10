-- Goose baseline representing Alembic head 0035_merge_superadmin_inventory.
-- Generated from a clean PostgreSQL 18 schema by applying the frozen Alembic history.
-- Existing databases must be verified at that exact Alembic head before baseline adoption.

-- +goose Up
--
-- PostgreSQL database dump
--


-- Dumped from database version 18.6 (Debian 18.6-1.pgdg13+2)
-- Dumped by pg_dump version 18.3 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: goose_export; Type: SCHEMA; Schema: -; Owner: -
--



--
-- Name: prevent_equipment_event_change(); Type: FUNCTION; Schema: goose_export; Owner: -
--

-- +goose StatementBegin
CREATE FUNCTION prevent_equipment_event_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
        BEGIN
            IF COALESCE(current_setting('app.allow_event_purge', true), 'off') = 'on' THEN
                RETURN OLD;  -- 放行：仅管理员删除设备事务通过 SET LOCAL 打开时生效
            END IF;
            RAISE EXCEPTION 'equipment event history is immutable';
        END; $$;
-- +goose StatementEnd


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: account_auxiliaries; Type: TABLE; Schema: goose_export; Owner: -
--

CREATE TABLE account_auxiliaries (
    id integer NOT NULL,
    account_book_id integer NOT NULL,
    account_id integer NOT NULL,
    auxiliary_item_id integer NOT NULL
);


--
-- Name: account_auxiliaries_id_seq; Type: SEQUENCE; Schema: goose_export; Owner: -
--

CREATE SEQUENCE account_auxiliaries_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: account_auxiliaries_id_seq; Type: SEQUENCE OWNED BY; Schema: goose_export; Owner: -
--

ALTER SEQUENCE account_auxiliaries_id_seq OWNED BY account_auxiliaries.id;


--
-- Name: account_balances; Type: TABLE; Schema: goose_export; Owner: -
--

CREATE TABLE account_balances (
    id integer NOT NULL,
    account_book_id integer NOT NULL,
    period_id integer NOT NULL,
    account_id integer NOT NULL,
    aux_key character varying(128) DEFAULT ''::character varying NOT NULL,
    opening_debit numeric(18,2) DEFAULT '0'::numeric NOT NULL,
    opening_credit numeric(18,2) DEFAULT '0'::numeric NOT NULL,
    debit_total numeric(18,2) DEFAULT '0'::numeric NOT NULL,
    credit_total numeric(18,2) DEFAULT '0'::numeric NOT NULL,
    ending_debit numeric(18,2) DEFAULT '0'::numeric NOT NULL,
    ending_credit numeric(18,2) DEFAULT '0'::numeric NOT NULL,
    CONSTRAINT ck_account_balance_nonneg CHECK (((opening_debit >= (0)::numeric) AND (opening_credit >= (0)::numeric) AND (debit_total >= (0)::numeric) AND (credit_total >= (0)::numeric) AND (ending_debit >= (0)::numeric) AND (ending_credit >= (0)::numeric)))
);


--
-- Name: account_balances_id_seq; Type: SEQUENCE; Schema: goose_export; Owner: -
--

CREATE SEQUENCE account_balances_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: account_balances_id_seq; Type: SEQUENCE OWNED BY; Schema: goose_export; Owner: -
--

ALTER SEQUENCE account_balances_id_seq OWNED BY account_balances.id;


--
-- Name: account_book_members; Type: TABLE; Schema: goose_export; Owner: -
--

CREATE TABLE account_book_members (
    id integer NOT NULL,
    account_book_id integer NOT NULL,
    user_id integer NOT NULL,
    role character varying(32) DEFAULT 'member'::character varying NOT NULL,
    created_at timestamp without time zone NOT NULL
);


--
-- Name: account_book_members_id_seq; Type: SEQUENCE; Schema: goose_export; Owner: -
--

CREATE SEQUENCE account_book_members_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: account_book_members_id_seq; Type: SEQUENCE OWNED BY; Schema: goose_export; Owner: -
--

ALTER SEQUENCE account_book_members_id_seq OWNED BY account_book_members.id;


--
-- Name: account_books; Type: TABLE; Schema: goose_export; Owner: -
--

CREATE TABLE account_books (
    id integer NOT NULL,
    code character varying(32) NOT NULL,
    name character varying(128) NOT NULL,
    base_currency character varying(3) DEFAULT 'CNY'::character varying NOT NULL,
    currencies json DEFAULT '["CNY"]'::json NOT NULL,
    fiscal_year_start character varying(5) DEFAULT '01-01'::character varying NOT NULL,
    status character varying(16) DEFAULT 'active'::character varying NOT NULL,
    created_by integer,
    created_at timestamp without time zone NOT NULL,
    deleted_at timestamp without time zone,
    deleted_by integer,
    CONSTRAINT ck_book_currency CHECK (((base_currency)::text ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT ck_book_status CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'archived'::character varying])::text[])))
);


--
-- Name: account_books_id_seq; Type: SEQUENCE; Schema: goose_export; Owner: -
--

CREATE SEQUENCE account_books_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: account_books_id_seq; Type: SEQUENCE OWNED BY; Schema: goose_export; Owner: -
--

ALTER SEQUENCE account_books_id_seq OWNED BY account_books.id;


--
-- Name: accounting_periods; Type: TABLE; Schema: goose_export; Owner: -
--

CREATE TABLE accounting_periods (
    id integer NOT NULL,
    account_book_id integer NOT NULL,
    year integer NOT NULL,
    month integer NOT NULL,
    period_index integer NOT NULL,
    is_adjustment boolean DEFAULT false NOT NULL,
    status character varying(16) DEFAULT 'open'::character varying NOT NULL,
    start_date date NOT NULL,
    end_date date NOT NULL,
    closed_by integer,
    closed_at timestamp without time zone,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT ck_period_adjustment CHECK (((month = 13) = is_adjustment)),
    CONSTRAINT ck_period_month CHECK (((month >= 1) AND (month <= 13))),
    CONSTRAINT ck_period_range CHECK ((start_date <= end_date)),
    CONSTRAINT ck_period_status CHECK (((status)::text = ANY ((ARRAY['open'::character varying, 'closed'::character varying, 'locked'::character varying])::text[])))
);


--
-- Name: accounting_periods_id_seq; Type: SEQUENCE; Schema: goose_export; Owner: -
--

CREATE SEQUENCE accounting_periods_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: accounting_periods_id_seq; Type: SEQUENCE OWNED BY; Schema: goose_export; Owner: -
--

ALTER SEQUENCE accounting_periods_id_seq OWNED BY accounting_periods.id;


--
-- Name: accounts; Type: TABLE; Schema: goose_export; Owner: -
--

CREATE TABLE accounts (
    id integer NOT NULL,
    account_book_id integer NOT NULL,
    code character varying(32) NOT NULL,
    name character varying(128) NOT NULL,
    level integer NOT NULL,
    parent_id integer,
    direction character varying(1) NOT NULL,
    category character varying(16) NOT NULL,
    aux_flags json DEFAULT '{}'::json NOT NULL,
    is_leaf boolean DEFAULT true NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    subject_version character varying(16) DEFAULT '2022'::character varying NOT NULL,
    CONSTRAINT ck_account_aux_flags CHECK ((jsonb_typeof((aux_flags)::jsonb) = 'object'::text)),
    CONSTRAINT ck_account_category CHECK (((category)::text = ANY ((ARRAY['资产'::character varying, '负债'::character varying, '权益'::character varying, '成本'::character varying, '损益'::character varying])::text[]))),
    CONSTRAINT ck_account_code CHECK (((code)::text ~ '^[0-9]{4}([0-9]{2}){0,3}$'::text)),
    CONSTRAINT ck_account_direction CHECK (((direction)::text = ANY ((ARRAY['D'::character varying, 'C'::character varying])::text[]))),
    CONSTRAINT ck_account_level CHECK (((level >= 1) AND (level <= 4)))
);


--
-- Name: accounts_id_seq; Type: SEQUENCE; Schema: goose_export; Owner: -
--

CREATE SEQUENCE accounts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: accounts_id_seq; Type: SEQUENCE OWNED BY; Schema: goose_export; Owner: -
--

ALTER SEQUENCE accounts_id_seq OWNED BY accounts.id;


--
-- Name: approval_records; Type: TABLE; Schema: goose_export; Owner: -
--

CREATE TABLE approval_records (
    id integer NOT NULL,
    kind character varying(32) NOT NULL,
    ref_id integer NOT NULL,
    project_id integer,
    action character varying(32) DEFAULT ''::character varying,
    from_status character varying(16) DEFAULT ''::character varying,
    to_status character varying(16) DEFAULT ''::character varying,
    actor_id integer,
    reason text DEFAULT ''::text,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: approval_records_id_seq; Type: SEQUENCE; Schema: goose_export; Owner: -
--

CREATE SEQUENCE approval_records_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: approval_records_id_seq; Type: SEQUENCE OWNED BY; Schema: goose_export; Owner: -
--

ALTER SEQUENCE approval_records_id_seq OWNED BY approval_records.id;


--
-- Name: arap_allocations; Type: TABLE; Schema: goose_export; Owner: -
--

CREATE TABLE arap_allocations (
    id integer NOT NULL,
    account_book_id integer NOT NULL,
    source_id integer NOT NULL,
    target_id integer NOT NULL,
    amount numeric(18,2) NOT NULL,
    created_by integer,
    created_at timestamp without time zone NOT NULL,
    released_at timestamp without time zone,
    released_by integer,
    release_reason text DEFAULT ''::text NOT NULL,
    release_voucher_id integer,
    CONSTRAINT ck_arap_allocation_amount CHECK ((amount > (0)::numeric))
);


--
-- Name: arap_allocations_id_seq; Type: SEQUENCE; Schema: goose_export; Owner: -
--

CREATE SEQUENCE arap_allocations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: arap_allocations_id_seq; Type: SEQUENCE OWNED BY; Schema: goose_export; Owner: -
--

ALTER SEQUENCE arap_allocations_id_seq OWNED BY arap_allocations.id;


--
-- Name: arap_transactions; Type: TABLE; Schema: goose_export; Owner: -
--

CREATE TABLE arap_transactions (
    id integer NOT NULL,
    account_book_id integer NOT NULL,
    period_id integer NOT NULL,
    kind character varying(16) NOT NULL,
    transaction_date date NOT NULL,
    party_id integer NOT NULL,
    amount numeric(18,2) NOT NULL,
    applied_amount numeric(18,2) DEFAULT '0'::numeric NOT NULL,
    account_id integer NOT NULL,
    offset_account_id integer NOT NULL,
    summary character varying(255) DEFAULT ''::character varying NOT NULL,
    voucher_id integer,
    created_by integer,
    created_at timestamp without time zone NOT NULL,
    CONSTRAINT ck_arap_amounts CHECK (((amount > (0)::numeric) AND (applied_amount >= (0)::numeric) AND (applied_amount <= amount))),
    CONSTRAINT ck_arap_kind CHECK (((kind)::text = ANY ((ARRAY['receivable'::character varying, 'payable'::character varying])::text[])))
);


--
-- Name: arap_transactions_id_seq; Type: SEQUENCE; Schema: goose_export; Owner: -
--

CREATE SEQUENCE arap_transactions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: arap_transactions_id_seq; Type: SEQUENCE OWNED BY; Schema: goose_export; Owner: -
--

ALTER SEQUENCE arap_transactions_id_seq OWNED BY arap_transactions.id;


--
-- Name: asset_depreciations; Type: TABLE; Schema: goose_export; Owner: -
--

CREATE TABLE asset_depreciations (
    id integer NOT NULL,
    account_book_id integer NOT NULL,
    asset_id integer NOT NULL,
    period_id integer NOT NULL,
    amount numeric(18,2) NOT NULL,
    voucher_id integer,
    created_by integer,
    created_at timestamp without time zone NOT NULL,
    CONSTRAINT ck_asset_depreciation_amount CHECK ((amount > (0)::numeric))
);


--
-- Name: asset_depreciations_id_seq; Type: SEQUENCE; Schema: goose_export; Owner: -
--

CREATE SEQUENCE asset_depreciations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: asset_depreciations_id_seq; Type: SEQUENCE OWNED BY; Schema: goose_export; Owner: -
--

ALTER SEQUENCE asset_depreciations_id_seq OWNED BY asset_depreciations.id;


--
-- Name: attachments; Type: TABLE; Schema: goose_export; Owner: -
--

CREATE TABLE attachments (
    id integer NOT NULL,
    project_id integer,
    filename character varying(255),
    path character varying(512),
    size integer,
    content_type character varying(128),
    uploaded_by integer,
    uploaded_at timestamp without time zone,
    ref_type character varying(32) DEFAULT ''::character varying,
    ref_id integer,
    category character varying(32) DEFAULT ''::character varying,
    storage_backend character varying(16) DEFAULT 'local'::character varying NOT NULL,
    object_key character varying(512) DEFAULT ''::character varying NOT NULL,
    etag character varying(128) DEFAULT ''::character varying NOT NULL
);


--
-- Name: attachments_id_seq; Type: SEQUENCE; Schema: goose_export; Owner: -
--

CREATE SEQUENCE attachments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: attachments_id_seq; Type: SEQUENCE OWNED BY; Schema: goose_export; Owner: -
--

ALTER SEQUENCE attachments_id_seq OWNED BY attachments.id;


--
-- Name: audit_logs; Type: TABLE; Schema: goose_export; Owner: -
--

CREATE TABLE audit_logs (
    id integer NOT NULL,
    user_id integer,
    action character varying(64),
    resource character varying(64),
    resource_id character varying(64),
    detail text,
    ip character varying(64),
    created_at timestamp without time zone
);


--
-- Name: audit_logs_id_seq; Type: SEQUENCE; Schema: goose_export; Owner: -
--

CREATE SEQUENCE audit_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: audit_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: goose_export; Owner: -
--

ALTER SEQUENCE audit_logs_id_seq OWNED BY audit_logs.id;


--
-- Name: auxiliary_items; Type: TABLE; Schema: goose_export; Owner: -
--

CREATE TABLE auxiliary_items (
    id integer NOT NULL,
    account_book_id integer NOT NULL,
    kind character varying(16) NOT NULL,
    code character varying(64) NOT NULL,
    name character varying(128) NOT NULL,
    metadata json DEFAULT '{}'::json NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone NOT NULL,
    CONSTRAINT ck_aux_kind CHECK (((kind)::text = ANY ((ARRAY['customer'::character varying, 'vendor'::character varying, 'department'::character varying, 'employee'::character varying, 'project'::character varying, 'cashflow'::character varying])::text[])))
);


--
-- Name: auxiliary_items_id_seq; Type: SEQUENCE; Schema: goose_export; Owner: -
--

CREATE SEQUENCE auxiliary_items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: auxiliary_items_id_seq; Type: SEQUENCE OWNED BY; Schema: goose_export; Owner: -
--

ALTER SEQUENCE auxiliary_items_id_seq OWNED BY auxiliary_items.id;


--
-- Name: bank_statements; Type: TABLE; Schema: goose_export; Owner: -
--

CREATE TABLE bank_statements (
    id integer NOT NULL,
    account_book_id integer NOT NULL,
    period_id integer NOT NULL,
    external_id character varying(128) NOT NULL,
    transaction_date date NOT NULL,
    direction character varying(16) NOT NULL,
    amount numeric(18,2) NOT NULL,
    account_code character varying(32) DEFAULT ''::character varying NOT NULL,
    summary character varying(255) DEFAULT ''::character varying NOT NULL,
    counterparty character varying(128) DEFAULT ''::character varying NOT NULL,
    status character varying(16) DEFAULT 'unmatched'::character varying NOT NULL,
    matched_voucher_id integer,
    matched_at timestamp without time zone,
    matched_by integer,
    created_by integer,
    created_at timestamp without time zone NOT NULL,
    CONSTRAINT ck_bank_statement_amount CHECK ((amount > (0)::numeric)),
    CONSTRAINT ck_bank_statement_direction CHECK (((direction)::text = ANY ((ARRAY['inflow'::character varying, 'outflow'::character varying])::text[]))),
    CONSTRAINT ck_bank_statement_status CHECK (((status)::text = ANY ((ARRAY['unmatched'::character varying, 'matched'::character varying, 'ignored'::character varying])::text[])))
);


--
-- Name: bank_statements_id_seq; Type: SEQUENCE; Schema: goose_export; Owner: -
--

CREATE SEQUENCE bank_statements_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bank_statements_id_seq; Type: SEQUENCE OWNED BY; Schema: goose_export; Owner: -
--

ALTER SEQUENCE bank_statements_id_seq OWNED BY bank_statements.id;


--
-- Name: budget_adjusts; Type: TABLE; Schema: goose_export; Owner: -
--

CREATE TABLE budget_adjusts (
    id integer NOT NULL,
    budget_id integer,
    project_id integer,
    old_amount double precision,
    new_amount double precision,
    reason text,
    status character varying(16),
    by_id integer,
    approved_by integer,
    created_at timestamp without time zone,
    decision_reason text DEFAULT ''::text,
    decided_at timestamp without time zone
);


--
-- Name: budget_adjusts_id_seq; Type: SEQUENCE; Schema: goose_export; Owner: -
--

CREATE SEQUENCE budget_adjusts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: budget_adjusts_id_seq; Type: SEQUENCE OWNED BY; Schema: goose_export; Owner: -
--

ALTER SEQUENCE budget_adjusts_id_seq OWNED BY budget_adjusts.id;


--
-- Name: budgets; Type: TABLE; Schema: goose_export; Owner: -
--

CREATE TABLE budgets (
    id integer NOT NULL,
    project_id integer,
    subject character varying(32) NOT NULL,
    amount double precision NOT NULL,
    period_start date,
    period_end date,
    created_at timestamp without time zone,
    updated_at timestamp without time zone
);


--
-- Name: budgets_id_seq; Type: SEQUENCE; Schema: goose_export; Owner: -
--

CREATE SEQUENCE budgets_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: budgets_id_seq; Type: SEQUENCE OWNED BY; Schema: goose_export; Owner: -
--

ALTER SEQUENCE budgets_id_seq OWNED BY budgets.id;


--
-- Name: cash_transactions; Type: TABLE; Schema: goose_export; Owner: -
--

CREATE TABLE cash_transactions (
    id integer NOT NULL,
    account_book_id integer NOT NULL,
    period_id integer NOT NULL,
    kind character varying(16) NOT NULL,
    transaction_date date NOT NULL,
    amount numeric(18,2) NOT NULL,
    account_id integer NOT NULL,
    offset_account_id integer NOT NULL,
    summary character varying(255) DEFAULT ''::character varying NOT NULL,
    counterparty character varying(128) DEFAULT ''::character varying NOT NULL,
    cashflow_item character varying(32),
    status character varying(16) DEFAULT 'draft'::character varying NOT NULL,
    voucher_id integer,
    created_by integer,
    created_at timestamp without time zone NOT NULL,
    CONSTRAINT ck_cash_transaction_amount CHECK ((amount > (0)::numeric)),
    CONSTRAINT ck_cash_transaction_kind CHECK (((kind)::text = ANY ((ARRAY['receipt'::character varying, 'payment'::character varying, 'expense'::character varying])::text[])))
);


--
-- Name: cash_transactions_id_seq; Type: SEQUENCE; Schema: goose_export; Owner: -
--

CREATE SEQUENCE cash_transactions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cash_transactions_id_seq; Type: SEQUENCE OWNED BY; Schema: goose_export; Owner: -
--

ALTER SEQUENCE cash_transactions_id_seq OWNED BY cash_transactions.id;


--
-- Name: contact_profiles; Type: TABLE; Schema: goose_export; Owner: -
--

CREATE TABLE contact_profiles (
    id integer NOT NULL,
    user_id integer,
    employee_no character varying(32),
    "position" character varying(64) DEFAULT ''::character varying,
    manager_id integer,
    employment_type character varying(32) DEFAULT '正式'::character varying,
    employment_status character varying(16) DEFAULT 'active'::character varying,
    hire_date date,
    regular_date date,
    leave_date date,
    work_email character varying(128) DEFAULT ''::character varying,
    office_phone character varying(32) DEFAULT ''::character varying,
    work_location character varying(128) DEFAULT ''::character varying,
    contract_type character varying(32) DEFAULT ''::character varying,
    contract_start date,
    contract_end date,
    gender character varying(8) DEFAULT ''::character varying,
    birth_date date,
    id_card_no character varying(32) DEFAULT ''::character varying,
    native_place character varying(64) DEFAULT ''::character varying,
    political_status character varying(32) DEFAULT ''::character varying,
    marital_status character varying(16) DEFAULT ''::character varying,
    address character varying(255) DEFAULT ''::character varying,
    highest_education character varying(32) DEFAULT ''::character varying,
    school character varying(128) DEFAULT ''::character varying,
    major character varying(128) DEFAULT ''::character varying,
    graduation_date date,
    degree character varying(32) DEFAULT ''::character varying,
    emergency_contact character varying(64) DEFAULT ''::character varying,
    emergency_relation character varying(32) DEFAULT ''::character varying,
    emergency_phone character varying(32) DEFAULT ''::character varying,
    remark text DEFAULT ''::text,
    updated_by integer,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    name character varying(64) DEFAULT ''::character varying NOT NULL,
    mobile character varying(32) DEFAULT ''::character varying,
    dept_id integer
);


--
-- Name: contact_profiles_id_seq; Type: SEQUENCE; Schema: goose_export; Owner: -
--

CREATE SEQUENCE contact_profiles_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: contact_profiles_id_seq; Type: SEQUENCE OWNED BY; Schema: goose_export; Owner: -
--

ALTER SEQUENCE contact_profiles_id_seq OWNED BY contact_profiles.id;


--
-- Name: departments; Type: TABLE; Schema: goose_export; Owner: -
--

CREATE TABLE departments (
    id integer NOT NULL,
    name character varying(64) NOT NULL,
    parent_id integer
);


--
-- Name: departments_id_seq; Type: SEQUENCE; Schema: goose_export; Owner: -
--

CREATE SEQUENCE departments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: departments_id_seq; Type: SEQUENCE OWNED BY; Schema: goose_export; Owner: -
--

ALTER SEQUENCE departments_id_seq OWNED BY departments.id;


--
-- Name: dicts; Type: TABLE; Schema: goose_export; Owner: -
--

CREATE TABLE dicts (
    id integer NOT NULL,
    type character varying(32),
    code character varying(32),
    label character varying(64),
    sort integer
);


--
-- Name: dicts_id_seq; Type: SEQUENCE; Schema: goose_export; Owner: -
--

CREATE SEQUENCE dicts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: dicts_id_seq; Type: SEQUENCE OWNED BY; Schema: goose_export; Owner: -
--

ALTER SEQUENCE dicts_id_seq OWNED BY dicts.id;


--
-- Name: equipment_assets; Type: TABLE; Schema: goose_export; Owner: -
--

CREATE TABLE equipment_assets (
    id integer NOT NULL,
    code character varying(40) NOT NULL,
    name character varying(128) NOT NULL,
    category_code character varying(32) NOT NULL,
    serial_number character varying(128),
    brand character varying(128) NOT NULL,
    model character varying(128) NOT NULL,
    location character varying(128) NOT NULL,
    note text NOT NULL,
    purchase_date date,
    purchase_price numeric(14,2),
    status character varying(20) NOT NULL,
    holder_id integer,
    due_date date,
    batch_id integer,
    created_by integer NOT NULL,
    created_at timestamp without time zone NOT NULL,
    updated_at timestamp without time zone NOT NULL,
    quantity integer NOT NULL,
    available_quantity integer NOT NULL,
    inventory_managed boolean NOT NULL,
    CONSTRAINT ck_equipment_available_quantity_range CHECK (((available_quantity >= 0) AND (available_quantity <= quantity))),
    CONSTRAINT ck_equipment_quantity_positive CHECK ((quantity > 0)),
    CONSTRAINT ck_equipment_single_asset_quantity CHECK ((inventory_managed OR ((quantity = 1) AND (available_quantity = 1)))),
    CONSTRAINT ck_equipment_status CHECK (((status)::text = ANY ((ARRAY['pending_acceptance'::character varying, 'available'::character varying, 'claimed'::character varying, 'borrowed'::character varying, 'maintenance'::character varying, 'scrapped'::character varying, 'void'::character varying])::text[])))
);


--
-- Name: equipment_assets_id_seq; Type: SEQUENCE; Schema: goose_export; Owner: -
--

CREATE SEQUENCE equipment_assets_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: equipment_assets_id_seq; Type: SEQUENCE OWNED BY; Schema: goose_export; Owner: -
--

ALTER SEQUENCE equipment_assets_id_seq OWNED BY equipment_assets.id;


--
-- Name: equipment_batches; Type: TABLE; Schema: goose_export; Owner: -
--

CREATE TABLE equipment_batches (
    id integer NOT NULL,
    source character varying(255) NOT NULL,
    note text NOT NULL,
    created_by integer NOT NULL,
    created_at timestamp without time zone NOT NULL,
    supplier character varying(255) NOT NULL,
    purchase_order_no character varying(128) NOT NULL,
    invoice_no character varying(128) NOT NULL,
    acceptance_status character varying(24) NOT NULL,
    name character varying(128) NOT NULL,
    CONSTRAINT ck_equipment_batch_acceptance_status CHECK (((acceptance_status)::text = ANY ((ARRAY['pending_acceptance'::character varying, 'accepted'::character varying])::text[])))
);


--
-- Name: equipment_batches_id_seq; Type: SEQUENCE; Schema: goose_export; Owner: -
--

CREATE SEQUENCE equipment_batches_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: equipment_batches_id_seq; Type: SEQUENCE OWNED BY; Schema: goose_export; Owner: -
--

ALTER SEQUENCE equipment_batches_id_seq OWNED BY equipment_batches.id;


--
-- Name: equipment_events; Type: TABLE; Schema: goose_export; Owner: -
--

CREATE TABLE equipment_events (
    id integer NOT NULL,
    asset_id integer NOT NULL,
    batch_id integer,
    action character varying(24) NOT NULL,
    from_status character varying(20),
    to_status character varying(20) NOT NULL,
    actor_id integer NOT NULL,
    holder_id integer,
    due_date date,
    note text NOT NULL,
    created_at timestamp without time zone NOT NULL,
    quantity integer,
    customer character varying(255),
    destination character varying(255),
    shipped_at timestamp without time zone,
    CONSTRAINT ck_equipment_outbound_details CHECK ((((action)::text <> 'outbound'::text) OR ((quantity > 0) AND (shipped_at IS NOT NULL) AND ((length(TRIM(BOTH FROM COALESCE(customer, ''::character varying))) > 0) OR (length(TRIM(BOTH FROM COALESCE(destination, ''::character varying))) > 0)))))
);


--
-- Name: equipment_events_id_seq; Type: SEQUENCE; Schema: goose_export; Owner: -
--

CREATE SEQUENCE equipment_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: equipment_events_id_seq; Type: SEQUENCE OWNED BY; Schema: goose_export; Owner: -
--

ALTER SEQUENCE equipment_events_id_seq OWNED BY equipment_events.id;


--
-- Name: expenses; Type: TABLE; Schema: goose_export; Owner: -
--

CREATE TABLE expenses (
    id integer NOT NULL,
    project_id integer,
    subject character varying(32),
    amount double precision NOT NULL,
    exp_date date,
    note text,
    status character varying(16),
    by_id integer,
    approved_by integer,
    created_at timestamp without time zone,
    decision_reason text DEFAULT ''::text,
    decided_at timestamp without time zone,
    resubmit_count integer DEFAULT 0
);


--
-- Name: expenses_id_seq; Type: SEQUENCE; Schema: goose_export; Owner: -
--

CREATE SEQUENCE expenses_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: expenses_id_seq; Type: SEQUENCE OWNED BY; Schema: goose_export; Owner: -
--

ALTER SEQUENCE expenses_id_seq OWNED BY expenses.id;


--
-- Name: fixed_assets; Type: TABLE; Schema: goose_export; Owner: -
--

CREATE TABLE fixed_assets (
    id integer NOT NULL,
    account_book_id integer NOT NULL,
    code character varying(64) NOT NULL,
    name character varying(128) NOT NULL,
    category character varying(64) DEFAULT ''::character varying NOT NULL,
    acquisition_date date NOT NULL,
    original_cost numeric(18,2) NOT NULL,
    residual_rate numeric(8,6) DEFAULT '0'::numeric NOT NULL,
    useful_life_months integer NOT NULL,
    asset_account_id integer NOT NULL,
    depreciation_account_id integer NOT NULL,
    expense_account_id integer NOT NULL,
    accumulated_depreciation numeric(18,2) DEFAULT '0'::numeric NOT NULL,
    status character varying(16) DEFAULT 'active'::character varying NOT NULL,
    created_by integer,
    created_at timestamp without time zone NOT NULL,
    CONSTRAINT ck_fixed_asset_cost CHECK ((original_cost > (0)::numeric)),
    CONSTRAINT ck_fixed_asset_life CHECK ((useful_life_months > 0)),
    CONSTRAINT ck_fixed_asset_residual_rate CHECK (((residual_rate >= (0)::numeric) AND (residual_rate < (1)::numeric))),
    CONSTRAINT ck_fixed_asset_status CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'disposed'::character varying])::text[])))
);


--
-- Name: fixed_assets_id_seq; Type: SEQUENCE; Schema: goose_export; Owner: -
--

CREATE SEQUENCE fixed_assets_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: fixed_assets_id_seq; Type: SEQUENCE OWNED BY; Schema: goose_export; Owner: -
--

ALTER SEQUENCE fixed_assets_id_seq OWNED BY fixed_assets.id;


--
-- Name: followups; Type: TABLE; Schema: goose_export; Owner: -
--

CREATE TABLE followups (
    id integer NOT NULL,
    project_id integer,
    user_id integer,
    happened_at timestamp without time zone,
    method character varying(32),
    content text,
    next_step text,
    remind_at timestamp without time zone,
    created_at timestamp without time zone,
    remind_state character varying(16) DEFAULT 'pending'::character varying,
    reminded_at timestamp without time zone,
    handled_at timestamp without time zone,
    handle_note text DEFAULT ''::text,
    handled_by integer
);


--
-- Name: followups_id_seq; Type: SEQUENCE; Schema: goose_export; Owner: -
--

CREATE SEQUENCE followups_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: followups_id_seq; Type: SEQUENCE OWNED BY; Schema: goose_export; Owner: -
--

ALTER SEQUENCE followups_id_seq OWNED BY followups.id;


--
-- Name: milestones; Type: TABLE; Schema: goose_export; Owner: -
--

CREATE TABLE milestones (
    id integer NOT NULL,
    project_id integer,
    name character varying(128) NOT NULL,
    plan_date date,
    actual_date date,
    owner_id integer,
    status character varying(16),
    created_at timestamp without time zone
);


--
-- Name: milestones_id_seq; Type: SEQUENCE; Schema: goose_export; Owner: -
--

CREATE SEQUENCE milestones_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: milestones_id_seq; Type: SEQUENCE OWNED BY; Schema: goose_export; Owner: -
--

ALTER SEQUENCE milestones_id_seq OWNED BY milestones.id;


--
-- Name: notifications; Type: TABLE; Schema: goose_export; Owner: -
--

CREATE TABLE notifications (
    id integer NOT NULL,
    user_id integer NOT NULL,
    type character varying(32),
    title character varying(128),
    body text,
    channel character varying(16),
    ref_type character varying(32),
    ref_id integer,
    project_id integer,
    dedup_key character varying(128),
    read_at timestamp without time zone,
    created_at timestamp without time zone,
    state character varying(16) DEFAULT 'pending'::character varying,
    handled_at timestamp without time zone,
    handle_note text DEFAULT ''::text,
    handled_by integer
);


--
-- Name: notifications_id_seq; Type: SEQUENCE; Schema: goose_export; Owner: -
--

CREATE SEQUENCE notifications_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: notifications_id_seq; Type: SEQUENCE OWNED BY; Schema: goose_export; Owner: -
--

ALTER SEQUENCE notifications_id_seq OWNED BY notifications.id;


--
-- Name: opening_balances; Type: TABLE; Schema: goose_export; Owner: -
--

CREATE TABLE opening_balances (
    id integer NOT NULL,
    account_book_id integer NOT NULL,
    account_id integer NOT NULL,
    aux_key character varying(128) DEFAULT ''::character varying NOT NULL,
    aux_detail json DEFAULT '{}'::json NOT NULL,
    debit numeric(18,2) DEFAULT '0'::numeric NOT NULL,
    credit numeric(18,2) DEFAULT '0'::numeric NOT NULL,
    CONSTRAINT ck_opening_nonneg CHECK (((debit >= (0)::numeric) AND (credit >= (0)::numeric))),
    CONSTRAINT ck_opening_one_side CHECK ((NOT ((debit > (0)::numeric) AND (credit > (0)::numeric))))
);


--
-- Name: opening_balances_id_seq; Type: SEQUENCE; Schema: goose_export; Owner: -
--

CREATE SEQUENCE opening_balances_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: opening_balances_id_seq; Type: SEQUENCE OWNED BY; Schema: goose_export; Owner: -
--

ALTER SEQUENCE opening_balances_id_seq OWNED BY opening_balances.id;


--
-- Name: opportunities; Type: TABLE; Schema: goose_export; Owner: -
--

CREATE TABLE opportunities (
    id integer NOT NULL,
    code character varying(32) NOT NULL,
    name character varying(128) NOT NULL,
    client character varying(128) DEFAULT ''::character varying,
    owner_id integer,
    owner_name character varying(64) DEFAULT ''::character varying,
    budget_total double precision DEFAULT '0'::double precision,
    stage character varying(16) DEFAULT 'new'::character varying,
    expected_close date,
    description text DEFAULT ''::text,
    deleted_at timestamp without time zone,
    created_by integer,
    created_at timestamp without time zone,
    updated_at timestamp without time zone
);


--
-- Name: opportunities_id_seq; Type: SEQUENCE; Schema: goose_export; Owner: -
--

CREATE SEQUENCE opportunities_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: opportunities_id_seq; Type: SEQUENCE OWNED BY; Schema: goose_export; Owner: -
--

ALTER SEQUENCE opportunities_id_seq OWNED BY opportunities.id;


--
-- Name: partner_contracts; Type: TABLE; Schema: goose_export; Owner: -
--

CREATE TABLE partner_contracts (
    id integer NOT NULL,
    partner_id integer NOT NULL,
    project_name character varying(128) DEFAULT ''::character varying NOT NULL,
    amount double precision DEFAULT '0'::double precision,
    signed_date date,
    remark text DEFAULT ''::text,
    created_at timestamp without time zone
);


--
-- Name: partner_contracts_id_seq; Type: SEQUENCE; Schema: goose_export; Owner: -
--

CREATE SEQUENCE partner_contracts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: partner_contracts_id_seq; Type: SEQUENCE OWNED BY; Schema: goose_export; Owner: -
--

ALTER SEQUENCE partner_contracts_id_seq OWNED BY partner_contracts.id;


--
-- Name: partners; Type: TABLE; Schema: goose_export; Owner: -
--

CREATE TABLE partners (
    id integer NOT NULL,
    name character varying(128) NOT NULL,
    contact_name character varying(64) DEFAULT ''::character varying,
    phone character varying(64) DEFAULT ''::character varying,
    email character varying(128) DEFAULT ''::character varying,
    address character varying(255) DEFAULT ''::character varying,
    remark text DEFAULT ''::text,
    created_by integer,
    updated_by integer,
    created_at timestamp without time zone,
    updated_at timestamp without time zone
);


--
-- Name: partners_id_seq; Type: SEQUENCE; Schema: goose_export; Owner: -
--

CREATE SEQUENCE partners_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: partners_id_seq; Type: SEQUENCE OWNED BY; Schema: goose_export; Owner: -
--

ALTER SEQUENCE partners_id_seq OWNED BY partners.id;


--
-- Name: progress_logs; Type: TABLE; Schema: goose_export; Owner: -
--

CREATE TABLE progress_logs (
    id integer NOT NULL,
    task_id integer,
    project_id integer,
    user_id integer,
    progress double precision,
    note text,
    remaining_days integer,
    created_at timestamp without time zone
);


--
-- Name: progress_logs_id_seq; Type: SEQUENCE; Schema: goose_export; Owner: -
--

CREATE SEQUENCE progress_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: progress_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: goose_export; Owner: -
--

ALTER SEQUENCE progress_logs_id_seq OWNED BY progress_logs.id;


--
-- Name: project_changes; Type: TABLE; Schema: goose_export; Owner: -
--

CREATE TABLE project_changes (
    id integer NOT NULL,
    project_id integer,
    field character varying(64),
    old text,
    new text,
    by_id integer,
    at timestamp without time zone
);


--
-- Name: project_changes_id_seq; Type: SEQUENCE; Schema: goose_export; Owner: -
--

CREATE SEQUENCE project_changes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: project_changes_id_seq; Type: SEQUENCE OWNED BY; Schema: goose_export; Owner: -
--

ALTER SEQUENCE project_changes_id_seq OWNED BY project_changes.id;


--
-- Name: project_members; Type: TABLE; Schema: goose_export; Owner: -
--

CREATE TABLE project_members (
    project_id integer NOT NULL,
    user_id integer NOT NULL
);


--
-- Name: project_receivable_payments; Type: TABLE; Schema: goose_export; Owner: -
--

CREATE TABLE project_receivable_payments (
    id integer NOT NULL,
    project_id integer NOT NULL,
    receivable_id integer NOT NULL,
    amount numeric(18,2) NOT NULL,
    payment_date date NOT NULL,
    note text DEFAULT ''::text NOT NULL,
    created_by integer NOT NULL,
    created_at timestamp without time zone NOT NULL,
    updated_at timestamp without time zone NOT NULL,
    deleted_at timestamp without time zone,
    deleted_by integer,
    updated_by integer NOT NULL,
    CONSTRAINT ck_project_receivable_payment_amount CHECK ((amount > (0)::numeric))
);


--
-- Name: project_receivable_payments_id_seq; Type: SEQUENCE; Schema: goose_export; Owner: -
--

CREATE SEQUENCE project_receivable_payments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: project_receivable_payments_id_seq; Type: SEQUENCE OWNED BY; Schema: goose_export; Owner: -
--

ALTER SEQUENCE project_receivable_payments_id_seq OWNED BY project_receivable_payments.id;


--
-- Name: project_receivables; Type: TABLE; Schema: goose_export; Owner: -
--

CREATE TABLE project_receivables (
    id integer NOT NULL,
    project_id integer NOT NULL,
    name character varying(128) NOT NULL,
    amount numeric(18,2) NOT NULL,
    receivable_date date NOT NULL,
    due_date date NOT NULL,
    note text DEFAULT ''::text NOT NULL,
    created_by integer NOT NULL,
    created_at timestamp without time zone NOT NULL,
    updated_at timestamp without time zone NOT NULL,
    deleted_at timestamp without time zone,
    deleted_by integer,
    updated_by integer NOT NULL,
    CONSTRAINT ck_project_receivable_amount CHECK ((amount > (0)::numeric)),
    CONSTRAINT ck_project_receivable_date_range CHECK ((due_date >= receivable_date))
);


--
-- Name: project_receivables_id_seq; Type: SEQUENCE; Schema: goose_export; Owner: -
--

CREATE SEQUENCE project_receivables_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: project_receivables_id_seq; Type: SEQUENCE OWNED BY; Schema: goose_export; Owner: -
--

ALTER SEQUENCE project_receivables_id_seq OWNED BY project_receivables.id;


--
-- Name: projects; Type: TABLE; Schema: goose_export; Owner: -
--

CREATE TABLE projects (
    id integer NOT NULL,
    code character varying(32) NOT NULL,
    name character varying(128) NOT NULL,
    type character varying(32),
    dept_id integer,
    owner_id integer,
    plan_start date,
    plan_end date,
    budget_total double precision,
    priority character varying(16),
    client character varying(128),
    description text,
    status character varying(16),
    progress double precision,
    deleted_at timestamp without time zone,
    created_by integer,
    created_at timestamp without time zone,
    updated_at timestamp without time zone,
    is_demo boolean DEFAULT false NOT NULL,
    owner_name character varying(64) DEFAULT ''::character varying,
    contract_status character varying(16) DEFAULT ''::character varying,
    client_contact character varying(64) DEFAULT ''::character varying NOT NULL,
    client_phone character varying(64) DEFAULT ''::character varying NOT NULL
);


--
-- Name: projects_id_seq; Type: SEQUENCE; Schema: goose_export; Owner: -
--

CREATE SEQUENCE projects_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: projects_id_seq; Type: SEQUENCE OWNED BY; Schema: goose_export; Owner: -
--

ALTER SEQUENCE projects_id_seq OWNED BY projects.id;


--
-- Name: roles; Type: TABLE; Schema: goose_export; Owner: -
--

CREATE TABLE roles (
    id integer NOT NULL,
    code character varying(32) NOT NULL,
    name character varying(64) NOT NULL
);


--
-- Name: roles_id_seq; Type: SEQUENCE; Schema: goose_export; Owner: -
--

CREATE SEQUENCE roles_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: roles_id_seq; Type: SEQUENCE OWNED BY; Schema: goose_export; Owner: -
--

ALTER SEQUENCE roles_id_seq OWNED BY roles.id;


--
-- Name: sys_params; Type: TABLE; Schema: goose_export; Owner: -
--

CREATE TABLE sys_params (
    id integer NOT NULL,
    key character varying(64) NOT NULL,
    value character varying(255),
    "desc" character varying(255)
);


--
-- Name: sys_params_id_seq; Type: SEQUENCE; Schema: goose_export; Owner: -
--

CREATE SEQUENCE sys_params_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sys_params_id_seq; Type: SEQUENCE OWNED BY; Schema: goose_export; Owner: -
--

ALTER SEQUENCE sys_params_id_seq OWNED BY sys_params.id;


--
-- Name: tasks; Type: TABLE; Schema: goose_export; Owner: -
--

CREATE TABLE tasks (
    id integer NOT NULL,
    project_id integer,
    parent_id integer,
    level integer,
    name character varying(128) NOT NULL,
    owner_id integer,
    plan_start date,
    plan_end date,
    weight double precision,
    progress double precision,
    status character varying(16),
    predecessor_id integer,
    created_at timestamp without time zone,
    updated_at timestamp without time zone
);


--
-- Name: tasks_id_seq; Type: SEQUENCE; Schema: goose_export; Owner: -
--

CREATE SEQUENCE tasks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tasks_id_seq; Type: SEQUENCE OWNED BY; Schema: goose_export; Owner: -
--

ALTER SEQUENCE tasks_id_seq OWNED BY tasks.id;


--
-- Name: token_blacklist; Type: TABLE; Schema: goose_export; Owner: -
--

CREATE TABLE token_blacklist (
    id integer NOT NULL,
    jti character varying(64) NOT NULL,
    user_id integer,
    expires_at timestamp without time zone,
    created_at timestamp without time zone
);


--
-- Name: token_blacklist_id_seq; Type: SEQUENCE; Schema: goose_export; Owner: -
--

CREATE SEQUENCE token_blacklist_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: token_blacklist_id_seq; Type: SEQUENCE OWNED BY; Schema: goose_export; Owner: -
--

ALTER SEQUENCE token_blacklist_id_seq OWNED BY token_blacklist.id;


--
-- Name: user_modules; Type: TABLE; Schema: goose_export; Owner: -
--

CREATE TABLE user_modules (
    user_id integer NOT NULL,
    module character varying(32) NOT NULL
);


--
-- Name: user_roles; Type: TABLE; Schema: goose_export; Owner: -
--

CREATE TABLE user_roles (
    user_id integer NOT NULL,
    role_id integer NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: goose_export; Owner: -
--

CREATE TABLE users (
    id integer NOT NULL,
    username character varying(64) NOT NULL,
    pwd_hash character varying(255) NOT NULL,
    real_name character varying(64),
    status character varying(16),
    dept_id integer,
    failed_count integer,
    locked_until timestamp without time zone,
    must_change_pwd boolean,
    created_at timestamp without time zone,
    session_version integer DEFAULT 0 NOT NULL,
    modules_assigned boolean DEFAULT false NOT NULL,
    is_super_admin boolean DEFAULT false NOT NULL
);


--
-- Name: users_id_seq; Type: SEQUENCE; Schema: goose_export; Owner: -
--

CREATE SEQUENCE users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: users_id_seq; Type: SEQUENCE OWNED BY; Schema: goose_export; Owner: -
--

ALTER SEQUENCE users_id_seq OWNED BY users.id;


--
-- Name: voucher_entries; Type: TABLE; Schema: goose_export; Owner: -
--

CREATE TABLE voucher_entries (
    id integer NOT NULL,
    voucher_id integer NOT NULL,
    line_no integer NOT NULL,
    account_id integer NOT NULL,
    summary character varying(255) DEFAULT ''::character varying NOT NULL,
    debit numeric(18,2) DEFAULT '0'::numeric NOT NULL,
    credit numeric(18,2) DEFAULT '0'::numeric NOT NULL,
    aux_detail json DEFAULT '{}'::json NOT NULL,
    cashflow_item character varying(32),
    account_book_id integer NOT NULL,
    CONSTRAINT ck_voucher_entry_nonneg CHECK (((debit >= (0)::numeric) AND (credit >= (0)::numeric))),
    CONSTRAINT ck_voucher_entry_one_side CHECK (((debit > (0)::numeric) <> (credit > (0)::numeric)))
);


--
-- Name: voucher_entries_id_seq; Type: SEQUENCE; Schema: goose_export; Owner: -
--

CREATE SEQUENCE voucher_entries_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: voucher_entries_id_seq; Type: SEQUENCE OWNED BY; Schema: goose_export; Owner: -
--

ALTER SEQUENCE voucher_entries_id_seq OWNED BY voucher_entries.id;


--
-- Name: voucher_templates; Type: TABLE; Schema: goose_export; Owner: -
--

CREATE TABLE voucher_templates (
    id integer NOT NULL,
    account_book_id integer NOT NULL,
    code character varying(32) NOT NULL,
    name character varying(128) NOT NULL,
    lines json DEFAULT '[]'::json NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_by integer,
    created_at timestamp without time zone NOT NULL
);


--
-- Name: voucher_templates_id_seq; Type: SEQUENCE; Schema: goose_export; Owner: -
--

CREATE SEQUENCE voucher_templates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: voucher_templates_id_seq; Type: SEQUENCE OWNED BY; Schema: goose_export; Owner: -
--

ALTER SEQUENCE voucher_templates_id_seq OWNED BY voucher_templates.id;


--
-- Name: vouchers; Type: TABLE; Schema: goose_export; Owner: -
--

CREATE TABLE vouchers (
    id integer NOT NULL,
    account_book_id integer NOT NULL,
    period_id integer NOT NULL,
    voucher_no character varying(32) NOT NULL,
    voucher_date date NOT NULL,
    status character varying(16) DEFAULT 'draft'::character varying NOT NULL,
    source character varying(16) DEFAULT 'manual'::character varying NOT NULL,
    summary character varying(255) DEFAULT ''::character varying NOT NULL,
    total_debit numeric(18,2) DEFAULT '0'::numeric NOT NULL,
    total_credit numeric(18,2) DEFAULT '0'::numeric NOT NULL,
    created_by integer,
    reviewed_by integer,
    posted_by integer,
    voided_by integer,
    reversal_of integer,
    decision_reason text DEFAULT ''::text NOT NULL,
    created_at timestamp without time zone NOT NULL,
    updated_at timestamp without time zone NOT NULL,
    source_expense_id integer,
    CONSTRAINT ck_voucher_balanced CHECK (((total_debit >= (0)::numeric) AND (total_credit >= (0)::numeric) AND (total_debit = total_credit))),
    CONSTRAINT ck_voucher_status CHECK (((status)::text = ANY ((ARRAY['draft'::character varying, 'pending'::character varying, 'posted'::character varying, 'void'::character varying])::text[])))
);


--
-- Name: vouchers_id_seq; Type: SEQUENCE; Schema: goose_export; Owner: -
--

CREATE SEQUENCE vouchers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: vouchers_id_seq; Type: SEQUENCE OWNED BY; Schema: goose_export; Owner: -
--

ALTER SEQUENCE vouchers_id_seq OWNED BY vouchers.id;


--
-- Name: account_auxiliaries id; Type: DEFAULT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY account_auxiliaries ALTER COLUMN id SET DEFAULT nextval('account_auxiliaries_id_seq'::regclass);


--
-- Name: account_balances id; Type: DEFAULT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY account_balances ALTER COLUMN id SET DEFAULT nextval('account_balances_id_seq'::regclass);


--
-- Name: account_book_members id; Type: DEFAULT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY account_book_members ALTER COLUMN id SET DEFAULT nextval('account_book_members_id_seq'::regclass);


--
-- Name: account_books id; Type: DEFAULT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY account_books ALTER COLUMN id SET DEFAULT nextval('account_books_id_seq'::regclass);


--
-- Name: accounting_periods id; Type: DEFAULT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY accounting_periods ALTER COLUMN id SET DEFAULT nextval('accounting_periods_id_seq'::regclass);


--
-- Name: accounts id; Type: DEFAULT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY accounts ALTER COLUMN id SET DEFAULT nextval('accounts_id_seq'::regclass);


--
-- Name: approval_records id; Type: DEFAULT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY approval_records ALTER COLUMN id SET DEFAULT nextval('approval_records_id_seq'::regclass);


--
-- Name: arap_allocations id; Type: DEFAULT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY arap_allocations ALTER COLUMN id SET DEFAULT nextval('arap_allocations_id_seq'::regclass);


--
-- Name: arap_transactions id; Type: DEFAULT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY arap_transactions ALTER COLUMN id SET DEFAULT nextval('arap_transactions_id_seq'::regclass);


--
-- Name: asset_depreciations id; Type: DEFAULT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY asset_depreciations ALTER COLUMN id SET DEFAULT nextval('asset_depreciations_id_seq'::regclass);


--
-- Name: attachments id; Type: DEFAULT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY attachments ALTER COLUMN id SET DEFAULT nextval('attachments_id_seq'::regclass);


--
-- Name: audit_logs id; Type: DEFAULT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY audit_logs ALTER COLUMN id SET DEFAULT nextval('audit_logs_id_seq'::regclass);


--
-- Name: auxiliary_items id; Type: DEFAULT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY auxiliary_items ALTER COLUMN id SET DEFAULT nextval('auxiliary_items_id_seq'::regclass);


--
-- Name: bank_statements id; Type: DEFAULT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY bank_statements ALTER COLUMN id SET DEFAULT nextval('bank_statements_id_seq'::regclass);


--
-- Name: budget_adjusts id; Type: DEFAULT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY budget_adjusts ALTER COLUMN id SET DEFAULT nextval('budget_adjusts_id_seq'::regclass);


--
-- Name: budgets id; Type: DEFAULT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY budgets ALTER COLUMN id SET DEFAULT nextval('budgets_id_seq'::regclass);


--
-- Name: cash_transactions id; Type: DEFAULT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY cash_transactions ALTER COLUMN id SET DEFAULT nextval('cash_transactions_id_seq'::regclass);


--
-- Name: contact_profiles id; Type: DEFAULT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY contact_profiles ALTER COLUMN id SET DEFAULT nextval('contact_profiles_id_seq'::regclass);


--
-- Name: departments id; Type: DEFAULT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY departments ALTER COLUMN id SET DEFAULT nextval('departments_id_seq'::regclass);


--
-- Name: dicts id; Type: DEFAULT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY dicts ALTER COLUMN id SET DEFAULT nextval('dicts_id_seq'::regclass);


--
-- Name: equipment_assets id; Type: DEFAULT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY equipment_assets ALTER COLUMN id SET DEFAULT nextval('equipment_assets_id_seq'::regclass);


--
-- Name: equipment_batches id; Type: DEFAULT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY equipment_batches ALTER COLUMN id SET DEFAULT nextval('equipment_batches_id_seq'::regclass);


--
-- Name: equipment_events id; Type: DEFAULT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY equipment_events ALTER COLUMN id SET DEFAULT nextval('equipment_events_id_seq'::regclass);


--
-- Name: expenses id; Type: DEFAULT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY expenses ALTER COLUMN id SET DEFAULT nextval('expenses_id_seq'::regclass);


--
-- Name: fixed_assets id; Type: DEFAULT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY fixed_assets ALTER COLUMN id SET DEFAULT nextval('fixed_assets_id_seq'::regclass);


--
-- Name: followups id; Type: DEFAULT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY followups ALTER COLUMN id SET DEFAULT nextval('followups_id_seq'::regclass);


--
-- Name: milestones id; Type: DEFAULT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY milestones ALTER COLUMN id SET DEFAULT nextval('milestones_id_seq'::regclass);


--
-- Name: notifications id; Type: DEFAULT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY notifications ALTER COLUMN id SET DEFAULT nextval('notifications_id_seq'::regclass);


--
-- Name: opening_balances id; Type: DEFAULT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY opening_balances ALTER COLUMN id SET DEFAULT nextval('opening_balances_id_seq'::regclass);


--
-- Name: opportunities id; Type: DEFAULT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY opportunities ALTER COLUMN id SET DEFAULT nextval('opportunities_id_seq'::regclass);


--
-- Name: partner_contracts id; Type: DEFAULT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY partner_contracts ALTER COLUMN id SET DEFAULT nextval('partner_contracts_id_seq'::regclass);


--
-- Name: partners id; Type: DEFAULT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY partners ALTER COLUMN id SET DEFAULT nextval('partners_id_seq'::regclass);


--
-- Name: progress_logs id; Type: DEFAULT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY progress_logs ALTER COLUMN id SET DEFAULT nextval('progress_logs_id_seq'::regclass);


--
-- Name: project_changes id; Type: DEFAULT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY project_changes ALTER COLUMN id SET DEFAULT nextval('project_changes_id_seq'::regclass);


--
-- Name: project_receivable_payments id; Type: DEFAULT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY project_receivable_payments ALTER COLUMN id SET DEFAULT nextval('project_receivable_payments_id_seq'::regclass);


--
-- Name: project_receivables id; Type: DEFAULT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY project_receivables ALTER COLUMN id SET DEFAULT nextval('project_receivables_id_seq'::regclass);


--
-- Name: projects id; Type: DEFAULT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY projects ALTER COLUMN id SET DEFAULT nextval('projects_id_seq'::regclass);


--
-- Name: roles id; Type: DEFAULT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY roles ALTER COLUMN id SET DEFAULT nextval('roles_id_seq'::regclass);


--
-- Name: sys_params id; Type: DEFAULT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY sys_params ALTER COLUMN id SET DEFAULT nextval('sys_params_id_seq'::regclass);


--
-- Name: tasks id; Type: DEFAULT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY tasks ALTER COLUMN id SET DEFAULT nextval('tasks_id_seq'::regclass);


--
-- Name: token_blacklist id; Type: DEFAULT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY token_blacklist ALTER COLUMN id SET DEFAULT nextval('token_blacklist_id_seq'::regclass);


--
-- Name: users id; Type: DEFAULT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY users ALTER COLUMN id SET DEFAULT nextval('users_id_seq'::regclass);


--
-- Name: voucher_entries id; Type: DEFAULT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY voucher_entries ALTER COLUMN id SET DEFAULT nextval('voucher_entries_id_seq'::regclass);


--
-- Name: voucher_templates id; Type: DEFAULT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY voucher_templates ALTER COLUMN id SET DEFAULT nextval('voucher_templates_id_seq'::regclass);


--
-- Name: vouchers id; Type: DEFAULT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY vouchers ALTER COLUMN id SET DEFAULT nextval('vouchers_id_seq'::regclass);


--
-- Name: account_auxiliaries account_auxiliaries_pkey; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY account_auxiliaries
    ADD CONSTRAINT account_auxiliaries_pkey PRIMARY KEY (id);


--
-- Name: account_balances account_balances_pkey; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY account_balances
    ADD CONSTRAINT account_balances_pkey PRIMARY KEY (id);


--
-- Name: account_book_members account_book_members_pkey; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY account_book_members
    ADD CONSTRAINT account_book_members_pkey PRIMARY KEY (id);


--
-- Name: account_books account_books_pkey; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY account_books
    ADD CONSTRAINT account_books_pkey PRIMARY KEY (id);


--
-- Name: accounting_periods accounting_periods_pkey; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY accounting_periods
    ADD CONSTRAINT accounting_periods_pkey PRIMARY KEY (id);


--
-- Name: accounts accounts_pkey; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (id);


--
-- Name: approval_records approval_records_pkey; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY approval_records
    ADD CONSTRAINT approval_records_pkey PRIMARY KEY (id);


--
-- Name: arap_allocations arap_allocations_pkey; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY arap_allocations
    ADD CONSTRAINT arap_allocations_pkey PRIMARY KEY (id);


--
-- Name: arap_transactions arap_transactions_pkey; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY arap_transactions
    ADD CONSTRAINT arap_transactions_pkey PRIMARY KEY (id);


--
-- Name: asset_depreciations asset_depreciations_pkey; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY asset_depreciations
    ADD CONSTRAINT asset_depreciations_pkey PRIMARY KEY (id);


--
-- Name: attachments attachments_pkey; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY attachments
    ADD CONSTRAINT attachments_pkey PRIMARY KEY (id);


--
-- Name: audit_logs audit_logs_pkey; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);


--
-- Name: auxiliary_items auxiliary_items_pkey; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY auxiliary_items
    ADD CONSTRAINT auxiliary_items_pkey PRIMARY KEY (id);


--
-- Name: bank_statements bank_statements_pkey; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY bank_statements
    ADD CONSTRAINT bank_statements_pkey PRIMARY KEY (id);


--
-- Name: budget_adjusts budget_adjusts_pkey; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY budget_adjusts
    ADD CONSTRAINT budget_adjusts_pkey PRIMARY KEY (id);


--
-- Name: budgets budgets_pkey; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY budgets
    ADD CONSTRAINT budgets_pkey PRIMARY KEY (id);


--
-- Name: cash_transactions cash_transactions_pkey; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY cash_transactions
    ADD CONSTRAINT cash_transactions_pkey PRIMARY KEY (id);


--
-- Name: contact_profiles contact_profiles_pkey; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY contact_profiles
    ADD CONSTRAINT contact_profiles_pkey PRIMARY KEY (id);


--
-- Name: departments departments_name_key; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY departments
    ADD CONSTRAINT departments_name_key UNIQUE (name);


--
-- Name: departments departments_pkey; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY departments
    ADD CONSTRAINT departments_pkey PRIMARY KEY (id);


--
-- Name: dicts dicts_pkey; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY dicts
    ADD CONSTRAINT dicts_pkey PRIMARY KEY (id);


--
-- Name: equipment_assets equipment_assets_code_key; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY equipment_assets
    ADD CONSTRAINT equipment_assets_code_key UNIQUE (code);


--
-- Name: equipment_assets equipment_assets_pkey; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY equipment_assets
    ADD CONSTRAINT equipment_assets_pkey PRIMARY KEY (id);


--
-- Name: equipment_assets equipment_assets_serial_number_key; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY equipment_assets
    ADD CONSTRAINT equipment_assets_serial_number_key UNIQUE (serial_number);


--
-- Name: equipment_batches equipment_batches_pkey; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY equipment_batches
    ADD CONSTRAINT equipment_batches_pkey PRIMARY KEY (id);


--
-- Name: equipment_events equipment_events_pkey; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY equipment_events
    ADD CONSTRAINT equipment_events_pkey PRIMARY KEY (id);


--
-- Name: expenses expenses_pkey; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY expenses
    ADD CONSTRAINT expenses_pkey PRIMARY KEY (id);


--
-- Name: fixed_assets fixed_assets_pkey; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY fixed_assets
    ADD CONSTRAINT fixed_assets_pkey PRIMARY KEY (id);


--
-- Name: followups followups_pkey; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY followups
    ADD CONSTRAINT followups_pkey PRIMARY KEY (id);


--
-- Name: milestones milestones_pkey; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY milestones
    ADD CONSTRAINT milestones_pkey PRIMARY KEY (id);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: opening_balances opening_balances_pkey; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY opening_balances
    ADD CONSTRAINT opening_balances_pkey PRIMARY KEY (id);


--
-- Name: opportunities opportunities_pkey; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY opportunities
    ADD CONSTRAINT opportunities_pkey PRIMARY KEY (id);


--
-- Name: partner_contracts partner_contracts_pkey; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY partner_contracts
    ADD CONSTRAINT partner_contracts_pkey PRIMARY KEY (id);


--
-- Name: partners partners_pkey; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY partners
    ADD CONSTRAINT partners_pkey PRIMARY KEY (id);


--
-- Name: progress_logs progress_logs_pkey; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY progress_logs
    ADD CONSTRAINT progress_logs_pkey PRIMARY KEY (id);


--
-- Name: project_changes project_changes_pkey; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY project_changes
    ADD CONSTRAINT project_changes_pkey PRIMARY KEY (id);


--
-- Name: project_members project_members_pkey; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY project_members
    ADD CONSTRAINT project_members_pkey PRIMARY KEY (project_id, user_id);


--
-- Name: project_receivable_payments project_receivable_payments_pkey; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY project_receivable_payments
    ADD CONSTRAINT project_receivable_payments_pkey PRIMARY KEY (id);


--
-- Name: project_receivables project_receivables_pkey; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY project_receivables
    ADD CONSTRAINT project_receivables_pkey PRIMARY KEY (id);


--
-- Name: projects projects_name_key; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY projects
    ADD CONSTRAINT projects_name_key UNIQUE (name);


--
-- Name: projects projects_pkey; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);


--
-- Name: roles roles_code_key; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY roles
    ADD CONSTRAINT roles_code_key UNIQUE (code);


--
-- Name: roles roles_pkey; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (id);


--
-- Name: sys_params sys_params_key_key; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY sys_params
    ADD CONSTRAINT sys_params_key_key UNIQUE (key);


--
-- Name: sys_params sys_params_pkey; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY sys_params
    ADD CONSTRAINT sys_params_pkey PRIMARY KEY (id);


--
-- Name: tasks tasks_pkey; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY tasks
    ADD CONSTRAINT tasks_pkey PRIMARY KEY (id);


--
-- Name: token_blacklist token_blacklist_jti_key; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY token_blacklist
    ADD CONSTRAINT token_blacklist_jti_key UNIQUE (jti);


--
-- Name: token_blacklist token_blacklist_pkey; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY token_blacklist
    ADD CONSTRAINT token_blacklist_pkey PRIMARY KEY (id);


--
-- Name: account_auxiliaries uq_account_auxiliaries_book_id; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY account_auxiliaries
    ADD CONSTRAINT uq_account_auxiliaries_book_id UNIQUE (account_book_id, id);


--
-- Name: account_auxiliaries uq_account_auxiliary_link; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY account_auxiliaries
    ADD CONSTRAINT uq_account_auxiliary_link UNIQUE (account_book_id, account_id, auxiliary_item_id);


--
-- Name: account_balances uq_account_balance_book_id; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY account_balances
    ADD CONSTRAINT uq_account_balance_book_id UNIQUE (account_book_id, id);


--
-- Name: account_balances uq_account_balance_scope; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY account_balances
    ADD CONSTRAINT uq_account_balance_scope UNIQUE (account_book_id, period_id, account_id, aux_key);


--
-- Name: accounts uq_account_book_code; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY accounts
    ADD CONSTRAINT uq_account_book_code UNIQUE (account_book_id, code);


--
-- Name: accounts uq_accounts_book_id; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY accounts
    ADD CONSTRAINT uq_accounts_book_id UNIQUE (account_book_id, id);


--
-- Name: arap_allocations uq_arap_allocation_pair; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY arap_allocations
    ADD CONSTRAINT uq_arap_allocation_pair UNIQUE (account_book_id, source_id, target_id);


--
-- Name: asset_depreciations uq_asset_depreciation_period; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY asset_depreciations
    ADD CONSTRAINT uq_asset_depreciation_period UNIQUE (account_book_id, asset_id, period_id);


--
-- Name: auxiliary_items uq_aux_book_kind_code; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY auxiliary_items
    ADD CONSTRAINT uq_aux_book_kind_code UNIQUE (account_book_id, kind, code);


--
-- Name: auxiliary_items uq_auxiliary_items_book_id; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY auxiliary_items
    ADD CONSTRAINT uq_auxiliary_items_book_id UNIQUE (account_book_id, id);


--
-- Name: bank_statements uq_bank_statement_book_external; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY bank_statements
    ADD CONSTRAINT uq_bank_statement_book_external UNIQUE (account_book_id, external_id);


--
-- Name: account_book_members uq_book_member; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY account_book_members
    ADD CONSTRAINT uq_book_member UNIQUE (account_book_id, user_id);


--
-- Name: fixed_assets uq_fixed_asset_book_code; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY fixed_assets
    ADD CONSTRAINT uq_fixed_asset_book_code UNIQUE (account_book_id, code);


--
-- Name: fixed_assets uq_fixed_asset_book_id; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY fixed_assets
    ADD CONSTRAINT uq_fixed_asset_book_id UNIQUE (account_book_id, id);


--
-- Name: opening_balances uq_opening_book_account_aux; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY opening_balances
    ADD CONSTRAINT uq_opening_book_account_aux UNIQUE (account_book_id, account_id, aux_key);


--
-- Name: accounting_periods uq_period_book_id; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY accounting_periods
    ADD CONSTRAINT uq_period_book_id UNIQUE (account_book_id, id);


--
-- Name: accounting_periods uq_period_book_index; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY accounting_periods
    ADD CONSTRAINT uq_period_book_index UNIQUE (account_book_id, period_index);


--
-- Name: accounting_periods uq_period_book_year_month; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY accounting_periods
    ADD CONSTRAINT uq_period_book_year_month UNIQUE (account_book_id, year, month);


--
-- Name: project_receivables uq_project_receivables_project_id; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY project_receivables
    ADD CONSTRAINT uq_project_receivables_project_id UNIQUE (project_id, id);


--
-- Name: vouchers uq_voucher_book_id; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY vouchers
    ADD CONSTRAINT uq_voucher_book_id UNIQUE (account_book_id, id);


--
-- Name: vouchers uq_voucher_book_period_no; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY vouchers
    ADD CONSTRAINT uq_voucher_book_period_no UNIQUE (account_book_id, period_id, voucher_no);


--
-- Name: voucher_entries uq_voucher_entry_line; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY voucher_entries
    ADD CONSTRAINT uq_voucher_entry_line UNIQUE (voucher_id, line_no);


--
-- Name: voucher_templates uq_voucher_template_book_code; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY voucher_templates
    ADD CONSTRAINT uq_voucher_template_book_code UNIQUE (account_book_id, code);


--
-- Name: vouchers uq_vouchers_source_expense_id; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY vouchers
    ADD CONSTRAINT uq_vouchers_source_expense_id UNIQUE (source_expense_id);


--
-- Name: user_modules user_modules_pkey; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY user_modules
    ADD CONSTRAINT user_modules_pkey PRIMARY KEY (user_id, module);


--
-- Name: user_roles user_roles_pkey; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY user_roles
    ADD CONSTRAINT user_roles_pkey PRIMARY KEY (user_id, role_id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: voucher_entries voucher_entries_pkey; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY voucher_entries
    ADD CONSTRAINT voucher_entries_pkey PRIMARY KEY (id);


--
-- Name: voucher_templates voucher_templates_pkey; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY voucher_templates
    ADD CONSTRAINT voucher_templates_pkey PRIMARY KEY (id);


--
-- Name: vouchers vouchers_pkey; Type: CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY vouchers
    ADD CONSTRAINT vouchers_pkey PRIMARY KEY (id);


--
-- Name: ix_account_auxiliary_book; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_account_auxiliary_book ON account_auxiliaries USING btree (account_book_id);


--
-- Name: ix_account_balances_account; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_account_balances_account ON account_balances USING btree (account_book_id, account_id);


--
-- Name: ix_account_books_code; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE UNIQUE INDEX ix_account_books_code ON account_books USING btree (code);


--
-- Name: ix_account_books_deleted_at; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_account_books_deleted_at ON account_books USING btree (deleted_at);


--
-- Name: ix_accounts_account_book_id; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_accounts_account_book_id ON accounts USING btree (account_book_id);


--
-- Name: ix_accounts_book_parent; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_accounts_book_parent ON accounts USING btree (account_book_id, parent_id);


--
-- Name: ix_approval_records_created_at; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_approval_records_created_at ON approval_records USING btree (created_at);


--
-- Name: ix_approval_records_kind; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_approval_records_kind ON approval_records USING btree (kind);


--
-- Name: ix_approval_records_project_id; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_approval_records_project_id ON approval_records USING btree (project_id);


--
-- Name: ix_approval_records_ref; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_approval_records_ref ON approval_records USING btree (kind, ref_id, id);


--
-- Name: ix_approval_records_ref_id; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_approval_records_ref_id ON approval_records USING btree (ref_id);


--
-- Name: ix_arap_allocations_released_at; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_arap_allocations_released_at ON arap_allocations USING btree (released_at);


--
-- Name: ix_arap_transactions_book_party_kind; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_arap_transactions_book_party_kind ON arap_transactions USING btree (account_book_id, party_id, kind);


--
-- Name: ix_attachments_project_id; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_attachments_project_id ON attachments USING btree (project_id);


--
-- Name: ix_attachments_ref; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_attachments_ref ON attachments USING btree (ref_type, ref_id);


--
-- Name: ix_audit_logs_action; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_audit_logs_action ON audit_logs USING btree (action);


--
-- Name: ix_audit_logs_created_at; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_audit_logs_created_at ON audit_logs USING btree (created_at);


--
-- Name: ix_audit_logs_user_id; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_audit_logs_user_id ON audit_logs USING btree (user_id);


--
-- Name: ix_auxiliary_items_account_book_id; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_auxiliary_items_account_book_id ON auxiliary_items USING btree (account_book_id);


--
-- Name: ix_bank_statements_book_period_status; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_bank_statements_book_period_status ON bank_statements USING btree (account_book_id, period_id, status);


--
-- Name: ix_book_members_user; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_book_members_user ON account_book_members USING btree (user_id);


--
-- Name: ix_budgets_proj_subject; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_budgets_proj_subject ON budgets USING btree (project_id, subject);


--
-- Name: ix_budgets_project_id; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_budgets_project_id ON budgets USING btree (project_id);


--
-- Name: ix_cash_transactions_book_period; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_cash_transactions_book_period ON cash_transactions USING btree (account_book_id, period_id);


--
-- Name: ix_contact_profiles_dept_id; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_contact_profiles_dept_id ON contact_profiles USING btree (dept_id);


--
-- Name: ix_contact_profiles_employee_no; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE UNIQUE INDEX ix_contact_profiles_employee_no ON contact_profiles USING btree (employee_no);


--
-- Name: ix_contact_profiles_employment_status; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_contact_profiles_employment_status ON contact_profiles USING btree (employment_status);


--
-- Name: ix_contact_profiles_manager_id; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_contact_profiles_manager_id ON contact_profiles USING btree (manager_id);


--
-- Name: ix_contact_profiles_user_id; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE UNIQUE INDEX ix_contact_profiles_user_id ON contact_profiles USING btree (user_id);


--
-- Name: ix_dicts_type; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_dicts_type ON dicts USING btree (type);


--
-- Name: ix_equipment_assets_batch_id; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_equipment_assets_batch_id ON equipment_assets USING btree (batch_id);


--
-- Name: ix_equipment_assets_category_code; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_equipment_assets_category_code ON equipment_assets USING btree (category_code);


--
-- Name: ix_equipment_assets_code; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_equipment_assets_code ON equipment_assets USING btree (code);


--
-- Name: ix_equipment_assets_holder_id; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_equipment_assets_holder_id ON equipment_assets USING btree (holder_id);


--
-- Name: ix_equipment_assets_status; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_equipment_assets_status ON equipment_assets USING btree (status);


--
-- Name: ix_equipment_events_asset_id; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_equipment_events_asset_id ON equipment_events USING btree (asset_id);


--
-- Name: ix_equipment_events_created_at; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_equipment_events_created_at ON equipment_events USING btree (created_at);


--
-- Name: ix_equipment_events_outbound_time; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_equipment_events_outbound_time ON equipment_events USING btree (action, shipped_at);


--
-- Name: ix_expenses_proj_status; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_expenses_proj_status ON expenses USING btree (project_id, status);


--
-- Name: ix_expenses_proj_subject; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_expenses_proj_subject ON expenses USING btree (project_id, subject);


--
-- Name: ix_expenses_project_id; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_expenses_project_id ON expenses USING btree (project_id);


--
-- Name: ix_expenses_status; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_expenses_status ON expenses USING btree (status);


--
-- Name: ix_fixed_assets_book_status; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_fixed_assets_book_status ON fixed_assets USING btree (account_book_id, status);


--
-- Name: ix_followups_project_id; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_followups_project_id ON followups USING btree (project_id);


--
-- Name: ix_followups_remind_at; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_followups_remind_at ON followups USING btree (remind_at);


--
-- Name: ix_followups_remind_state; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_followups_remind_state ON followups USING btree (remind_state);


--
-- Name: ix_followups_reminded_at; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_followups_reminded_at ON followups USING btree (reminded_at);


--
-- Name: ix_followups_user_id; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_followups_user_id ON followups USING btree (user_id);


--
-- Name: ix_logs_proj_created; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_logs_proj_created ON progress_logs USING btree (project_id, created_at);


--
-- Name: ix_milestones_proj_status; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_milestones_proj_status ON milestones USING btree (project_id, status);


--
-- Name: ix_milestones_project_id; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_milestones_project_id ON milestones USING btree (project_id);


--
-- Name: ix_notif_user_read; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_notif_user_read ON notifications USING btree (user_id, read_at);


--
-- Name: ix_notifications_created_at; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_notifications_created_at ON notifications USING btree (created_at);


--
-- Name: ix_notifications_dedup_key; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_notifications_dedup_key ON notifications USING btree (dedup_key);


--
-- Name: ix_notifications_project_id; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_notifications_project_id ON notifications USING btree (project_id);


--
-- Name: ix_notifications_read_at; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_notifications_read_at ON notifications USING btree (read_at);


--
-- Name: ix_notifications_state; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_notifications_state ON notifications USING btree (state);


--
-- Name: ix_notifications_type; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_notifications_type ON notifications USING btree (type);


--
-- Name: ix_notifications_user_id; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_notifications_user_id ON notifications USING btree (user_id);


--
-- Name: ix_opening_balances_account_book_id; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_opening_balances_account_book_id ON opening_balances USING btree (account_book_id);


--
-- Name: ix_opportunities_code; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE UNIQUE INDEX ix_opportunities_code ON opportunities USING btree (code);


--
-- Name: ix_opportunities_deleted_at; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_opportunities_deleted_at ON opportunities USING btree (deleted_at);


--
-- Name: ix_opportunities_owner_id; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_opportunities_owner_id ON opportunities USING btree (owner_id);


--
-- Name: ix_opportunities_stage; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_opportunities_stage ON opportunities USING btree (stage);


--
-- Name: ix_partner_contracts_partner_id; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_partner_contracts_partner_id ON partner_contracts USING btree (partner_id);


--
-- Name: ix_partners_name; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE UNIQUE INDEX ix_partners_name ON partners USING btree (name);


--
-- Name: ix_periods_book_status; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_periods_book_status ON accounting_periods USING btree (account_book_id, status);


--
-- Name: ix_progress_logs_project_id; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_progress_logs_project_id ON progress_logs USING btree (project_id);


--
-- Name: ix_progress_logs_task_id; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_progress_logs_task_id ON progress_logs USING btree (task_id);


--
-- Name: ix_project_changes_project_id; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_project_changes_project_id ON project_changes USING btree (project_id);


--
-- Name: ix_project_receivable_payments_deleted_at; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_project_receivable_payments_deleted_at ON project_receivable_payments USING btree (deleted_at);


--
-- Name: ix_project_receivable_payments_project_id; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_project_receivable_payments_project_id ON project_receivable_payments USING btree (project_id);


--
-- Name: ix_project_receivable_payments_receivable_id; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_project_receivable_payments_receivable_id ON project_receivable_payments USING btree (receivable_id);


--
-- Name: ix_project_receivables_deleted_at; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_project_receivables_deleted_at ON project_receivables USING btree (deleted_at);


--
-- Name: ix_project_receivables_project_id; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_project_receivables_project_id ON project_receivables USING btree (project_id);


--
-- Name: ix_projects_code; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE UNIQUE INDEX ix_projects_code ON projects USING btree (code);


--
-- Name: ix_projects_deleted_at; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_projects_deleted_at ON projects USING btree (deleted_at);


--
-- Name: ix_projects_dept_id; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_projects_dept_id ON projects USING btree (dept_id);


--
-- Name: ix_projects_is_demo; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_projects_is_demo ON projects USING btree (is_demo);


--
-- Name: ix_projects_owner_id; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_projects_owner_id ON projects USING btree (owner_id);


--
-- Name: ix_projects_status; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_projects_status ON projects USING btree (status);


--
-- Name: ix_tasks_proj_status; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_tasks_proj_status ON tasks USING btree (project_id, status);


--
-- Name: ix_tasks_project_id; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_tasks_project_id ON tasks USING btree (project_id);


--
-- Name: ix_tasks_status; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_tasks_status ON tasks USING btree (status);


--
-- Name: ix_users_username; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE UNIQUE INDEX ix_users_username ON users USING btree (username);


--
-- Name: ix_voucher_entries_account; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_voucher_entries_account ON voucher_entries USING btree (account_id);


--
-- Name: ix_vouchers_book_status; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE INDEX ix_vouchers_book_status ON vouchers USING btree (account_book_id, status);


--
-- Name: uq_equipment_batches_name_lower; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE UNIQUE INDEX uq_equipment_batches_name_lower ON equipment_batches USING btree (lower((name)::text));


--
-- Name: uq_users_single_super_admin; Type: INDEX; Schema: goose_export; Owner: -
--

CREATE UNIQUE INDEX uq_users_single_super_admin ON users USING btree (is_super_admin) WHERE (is_super_admin = true);


--
-- Name: equipment_events equipment_events_immutable; Type: TRIGGER; Schema: goose_export; Owner: -
--

CREATE TRIGGER equipment_events_immutable BEFORE DELETE OR UPDATE ON equipment_events FOR EACH ROW EXECUTE FUNCTION prevent_equipment_event_change();


--
-- Name: account_auxiliaries account_auxiliaries_account_book_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY account_auxiliaries
    ADD CONSTRAINT account_auxiliaries_account_book_id_fkey FOREIGN KEY (account_book_id) REFERENCES account_books(id) ON DELETE CASCADE;


--
-- Name: account_balances account_balances_account_book_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY account_balances
    ADD CONSTRAINT account_balances_account_book_id_fkey FOREIGN KEY (account_book_id) REFERENCES account_books(id) ON DELETE CASCADE;


--
-- Name: account_book_members account_book_members_account_book_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY account_book_members
    ADD CONSTRAINT account_book_members_account_book_id_fkey FOREIGN KEY (account_book_id) REFERENCES account_books(id) ON DELETE CASCADE;


--
-- Name: account_book_members account_book_members_user_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY account_book_members
    ADD CONSTRAINT account_book_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;


--
-- Name: account_books account_books_created_by_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY account_books
    ADD CONSTRAINT account_books_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);


--
-- Name: account_books account_books_deleted_by_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY account_books
    ADD CONSTRAINT account_books_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES users(id);


--
-- Name: accounting_periods accounting_periods_account_book_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY accounting_periods
    ADD CONSTRAINT accounting_periods_account_book_id_fkey FOREIGN KEY (account_book_id) REFERENCES account_books(id) ON DELETE CASCADE;


--
-- Name: accounting_periods accounting_periods_closed_by_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY accounting_periods
    ADD CONSTRAINT accounting_periods_closed_by_fkey FOREIGN KEY (closed_by) REFERENCES users(id);


--
-- Name: accounts accounts_account_book_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY accounts
    ADD CONSTRAINT accounts_account_book_id_fkey FOREIGN KEY (account_book_id) REFERENCES account_books(id) ON DELETE CASCADE;


--
-- Name: approval_records approval_records_actor_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY approval_records
    ADD CONSTRAINT approval_records_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES users(id);


--
-- Name: approval_records approval_records_project_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY approval_records
    ADD CONSTRAINT approval_records_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: arap_allocations arap_allocations_account_book_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY arap_allocations
    ADD CONSTRAINT arap_allocations_account_book_id_fkey FOREIGN KEY (account_book_id) REFERENCES account_books(id) ON DELETE CASCADE;


--
-- Name: arap_allocations arap_allocations_created_by_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY arap_allocations
    ADD CONSTRAINT arap_allocations_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);


--
-- Name: arap_allocations arap_allocations_release_voucher_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY arap_allocations
    ADD CONSTRAINT arap_allocations_release_voucher_id_fkey FOREIGN KEY (release_voucher_id) REFERENCES vouchers(id);


--
-- Name: arap_allocations arap_allocations_released_by_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY arap_allocations
    ADD CONSTRAINT arap_allocations_released_by_fkey FOREIGN KEY (released_by) REFERENCES users(id);


--
-- Name: arap_transactions arap_transactions_account_book_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY arap_transactions
    ADD CONSTRAINT arap_transactions_account_book_id_fkey FOREIGN KEY (account_book_id) REFERENCES account_books(id) ON DELETE CASCADE;


--
-- Name: arap_transactions arap_transactions_created_by_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY arap_transactions
    ADD CONSTRAINT arap_transactions_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);


--
-- Name: arap_transactions arap_transactions_voucher_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY arap_transactions
    ADD CONSTRAINT arap_transactions_voucher_id_fkey FOREIGN KEY (voucher_id) REFERENCES vouchers(id);


--
-- Name: asset_depreciations asset_depreciations_account_book_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY asset_depreciations
    ADD CONSTRAINT asset_depreciations_account_book_id_fkey FOREIGN KEY (account_book_id) REFERENCES account_books(id) ON DELETE CASCADE;


--
-- Name: asset_depreciations asset_depreciations_asset_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY asset_depreciations
    ADD CONSTRAINT asset_depreciations_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES fixed_assets(id) ON DELETE CASCADE;


--
-- Name: asset_depreciations asset_depreciations_created_by_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY asset_depreciations
    ADD CONSTRAINT asset_depreciations_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);


--
-- Name: asset_depreciations asset_depreciations_voucher_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY asset_depreciations
    ADD CONSTRAINT asset_depreciations_voucher_id_fkey FOREIGN KEY (voucher_id) REFERENCES vouchers(id);


--
-- Name: attachments attachments_project_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY attachments
    ADD CONSTRAINT attachments_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: attachments attachments_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY attachments
    ADD CONSTRAINT attachments_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES users(id);


--
-- Name: audit_logs audit_logs_user_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY audit_logs
    ADD CONSTRAINT audit_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);


--
-- Name: auxiliary_items auxiliary_items_account_book_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY auxiliary_items
    ADD CONSTRAINT auxiliary_items_account_book_id_fkey FOREIGN KEY (account_book_id) REFERENCES account_books(id) ON DELETE CASCADE;


--
-- Name: bank_statements bank_statements_account_book_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY bank_statements
    ADD CONSTRAINT bank_statements_account_book_id_fkey FOREIGN KEY (account_book_id) REFERENCES account_books(id) ON DELETE CASCADE;


--
-- Name: bank_statements bank_statements_created_by_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY bank_statements
    ADD CONSTRAINT bank_statements_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);


--
-- Name: bank_statements bank_statements_matched_by_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY bank_statements
    ADD CONSTRAINT bank_statements_matched_by_fkey FOREIGN KEY (matched_by) REFERENCES users(id);


--
-- Name: bank_statements bank_statements_matched_voucher_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY bank_statements
    ADD CONSTRAINT bank_statements_matched_voucher_id_fkey FOREIGN KEY (matched_voucher_id) REFERENCES vouchers(id);


--
-- Name: budget_adjusts budget_adjusts_approved_by_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY budget_adjusts
    ADD CONSTRAINT budget_adjusts_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES users(id);


--
-- Name: budget_adjusts budget_adjusts_budget_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY budget_adjusts
    ADD CONSTRAINT budget_adjusts_budget_id_fkey FOREIGN KEY (budget_id) REFERENCES budgets(id) ON DELETE CASCADE;


--
-- Name: budget_adjusts budget_adjusts_by_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY budget_adjusts
    ADD CONSTRAINT budget_adjusts_by_id_fkey FOREIGN KEY (by_id) REFERENCES users(id);


--
-- Name: budget_adjusts budget_adjusts_project_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY budget_adjusts
    ADD CONSTRAINT budget_adjusts_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: budgets budgets_project_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY budgets
    ADD CONSTRAINT budgets_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: cash_transactions cash_transactions_account_book_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY cash_transactions
    ADD CONSTRAINT cash_transactions_account_book_id_fkey FOREIGN KEY (account_book_id) REFERENCES account_books(id) ON DELETE CASCADE;


--
-- Name: cash_transactions cash_transactions_created_by_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY cash_transactions
    ADD CONSTRAINT cash_transactions_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);


--
-- Name: cash_transactions cash_transactions_voucher_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY cash_transactions
    ADD CONSTRAINT cash_transactions_voucher_id_fkey FOREIGN KEY (voucher_id) REFERENCES vouchers(id);


--
-- Name: contact_profiles contact_profiles_dept_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY contact_profiles
    ADD CONSTRAINT contact_profiles_dept_id_fkey FOREIGN KEY (dept_id) REFERENCES departments(id);


--
-- Name: contact_profiles contact_profiles_updated_by_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY contact_profiles
    ADD CONSTRAINT contact_profiles_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES users(id);


--
-- Name: contact_profiles contact_profiles_user_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY contact_profiles
    ADD CONSTRAINT contact_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;


--
-- Name: departments departments_parent_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY departments
    ADD CONSTRAINT departments_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES departments(id);


--
-- Name: equipment_assets equipment_assets_batch_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY equipment_assets
    ADD CONSTRAINT equipment_assets_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES equipment_batches(id);


--
-- Name: equipment_assets equipment_assets_created_by_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY equipment_assets
    ADD CONSTRAINT equipment_assets_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);


--
-- Name: equipment_assets equipment_assets_holder_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY equipment_assets
    ADD CONSTRAINT equipment_assets_holder_id_fkey FOREIGN KEY (holder_id) REFERENCES users(id);


--
-- Name: equipment_batches equipment_batches_created_by_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY equipment_batches
    ADD CONSTRAINT equipment_batches_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);


--
-- Name: equipment_events equipment_events_actor_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY equipment_events
    ADD CONSTRAINT equipment_events_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES users(id);


--
-- Name: equipment_events equipment_events_asset_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY equipment_events
    ADD CONSTRAINT equipment_events_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES equipment_assets(id);


--
-- Name: equipment_events equipment_events_batch_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY equipment_events
    ADD CONSTRAINT equipment_events_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES equipment_batches(id);


--
-- Name: equipment_events equipment_events_holder_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY equipment_events
    ADD CONSTRAINT equipment_events_holder_id_fkey FOREIGN KEY (holder_id) REFERENCES users(id);


--
-- Name: expenses expenses_approved_by_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY expenses
    ADD CONSTRAINT expenses_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES users(id);


--
-- Name: expenses expenses_by_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY expenses
    ADD CONSTRAINT expenses_by_id_fkey FOREIGN KEY (by_id) REFERENCES users(id);


--
-- Name: expenses expenses_project_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY expenses
    ADD CONSTRAINT expenses_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: fixed_assets fixed_assets_account_book_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY fixed_assets
    ADD CONSTRAINT fixed_assets_account_book_id_fkey FOREIGN KEY (account_book_id) REFERENCES account_books(id) ON DELETE CASCADE;


--
-- Name: fixed_assets fixed_assets_created_by_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY fixed_assets
    ADD CONSTRAINT fixed_assets_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);


--
-- Name: account_auxiliaries fk_account_auxiliary_account_same_book; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY account_auxiliaries
    ADD CONSTRAINT fk_account_auxiliary_account_same_book FOREIGN KEY (account_book_id, account_id) REFERENCES accounts(account_book_id, id) ON DELETE CASCADE;


--
-- Name: account_auxiliaries fk_account_auxiliary_item_same_book; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY account_auxiliaries
    ADD CONSTRAINT fk_account_auxiliary_item_same_book FOREIGN KEY (account_book_id, auxiliary_item_id) REFERENCES auxiliary_items(account_book_id, id) ON DELETE CASCADE;


--
-- Name: account_balances fk_account_balance_account_same_book; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY account_balances
    ADD CONSTRAINT fk_account_balance_account_same_book FOREIGN KEY (account_book_id, account_id) REFERENCES accounts(account_book_id, id) ON DELETE CASCADE;


--
-- Name: account_balances fk_account_balance_period_same_book; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY account_balances
    ADD CONSTRAINT fk_account_balance_period_same_book FOREIGN KEY (account_book_id, period_id) REFERENCES accounting_periods(account_book_id, id) ON DELETE CASCADE;


--
-- Name: accounts fk_accounts_parent_same_book; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY accounts
    ADD CONSTRAINT fk_accounts_parent_same_book FOREIGN KEY (account_book_id, parent_id) REFERENCES accounts(account_book_id, id);


--
-- Name: arap_transactions fk_arap_period_same_book; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY arap_transactions
    ADD CONSTRAINT fk_arap_period_same_book FOREIGN KEY (account_book_id, period_id) REFERENCES accounting_periods(account_book_id, id);


--
-- Name: asset_depreciations fk_asset_depreciation_asset_same_book; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY asset_depreciations
    ADD CONSTRAINT fk_asset_depreciation_asset_same_book FOREIGN KEY (account_book_id, asset_id) REFERENCES fixed_assets(account_book_id, id) ON DELETE CASCADE;


--
-- Name: asset_depreciations fk_asset_depreciation_period_same_book; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY asset_depreciations
    ADD CONSTRAINT fk_asset_depreciation_period_same_book FOREIGN KEY (account_book_id, period_id) REFERENCES accounting_periods(account_book_id, id) ON DELETE CASCADE;


--
-- Name: cash_transactions fk_cash_transaction_account_same_book; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY cash_transactions
    ADD CONSTRAINT fk_cash_transaction_account_same_book FOREIGN KEY (account_book_id, account_id) REFERENCES accounts(account_book_id, id);


--
-- Name: cash_transactions fk_cash_transaction_offset_same_book; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY cash_transactions
    ADD CONSTRAINT fk_cash_transaction_offset_same_book FOREIGN KEY (account_book_id, offset_account_id) REFERENCES accounts(account_book_id, id);


--
-- Name: cash_transactions fk_cash_transaction_period_same_book; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY cash_transactions
    ADD CONSTRAINT fk_cash_transaction_period_same_book FOREIGN KEY (account_book_id, period_id) REFERENCES accounting_periods(account_book_id, id);


--
-- Name: contact_profiles fk_contact_profiles_manager_contact; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY contact_profiles
    ADD CONSTRAINT fk_contact_profiles_manager_contact FOREIGN KEY (manager_id) REFERENCES contact_profiles(id);


--
-- Name: fixed_assets fk_fixed_asset_asset_account; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY fixed_assets
    ADD CONSTRAINT fk_fixed_asset_asset_account FOREIGN KEY (account_book_id, asset_account_id) REFERENCES accounts(account_book_id, id);


--
-- Name: fixed_assets fk_fixed_asset_depreciation_account; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY fixed_assets
    ADD CONSTRAINT fk_fixed_asset_depreciation_account FOREIGN KEY (account_book_id, depreciation_account_id) REFERENCES accounts(account_book_id, id);


--
-- Name: fixed_assets fk_fixed_asset_expense_account; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY fixed_assets
    ADD CONSTRAINT fk_fixed_asset_expense_account FOREIGN KEY (account_book_id, expense_account_id) REFERENCES accounts(account_book_id, id);


--
-- Name: followups fk_followups_handled_by_users; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY followups
    ADD CONSTRAINT fk_followups_handled_by_users FOREIGN KEY (handled_by) REFERENCES users(id);


--
-- Name: notifications fk_notifications_handled_by_users; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY notifications
    ADD CONSTRAINT fk_notifications_handled_by_users FOREIGN KEY (handled_by) REFERENCES users(id);


--
-- Name: opening_balances fk_opening_account_same_book; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY opening_balances
    ADD CONSTRAINT fk_opening_account_same_book FOREIGN KEY (account_book_id, account_id) REFERENCES accounts(account_book_id, id);


--
-- Name: project_receivable_payments fk_project_receivable_payment_parent; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY project_receivable_payments
    ADD CONSTRAINT fk_project_receivable_payment_parent FOREIGN KEY (project_id, receivable_id) REFERENCES project_receivables(project_id, id) ON DELETE RESTRICT;


--
-- Name: project_receivable_payments fk_project_receivable_payments_updated_by_users; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY project_receivable_payments
    ADD CONSTRAINT fk_project_receivable_payments_updated_by_users FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE RESTRICT;


--
-- Name: project_receivables fk_project_receivables_updated_by_users; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY project_receivables
    ADD CONSTRAINT fk_project_receivables_updated_by_users FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE RESTRICT;


--
-- Name: voucher_entries fk_voucher_entry_account_same_book; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY voucher_entries
    ADD CONSTRAINT fk_voucher_entry_account_same_book FOREIGN KEY (account_book_id, account_id) REFERENCES accounts(account_book_id, id);


--
-- Name: voucher_entries fk_voucher_entry_voucher_same_book; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY voucher_entries
    ADD CONSTRAINT fk_voucher_entry_voucher_same_book FOREIGN KEY (account_book_id, voucher_id) REFERENCES vouchers(account_book_id, id) ON DELETE CASCADE;


--
-- Name: vouchers fk_voucher_period_same_book; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY vouchers
    ADD CONSTRAINT fk_voucher_period_same_book FOREIGN KEY (account_book_id, period_id) REFERENCES accounting_periods(account_book_id, id) ON DELETE CASCADE;


--
-- Name: vouchers fk_vouchers_source_expense_id_expenses; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY vouchers
    ADD CONSTRAINT fk_vouchers_source_expense_id_expenses FOREIGN KEY (source_expense_id) REFERENCES expenses(id) ON DELETE RESTRICT;


--
-- Name: followups followups_project_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY followups
    ADD CONSTRAINT followups_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: followups followups_user_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY followups
    ADD CONSTRAINT followups_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);


--
-- Name: milestones milestones_owner_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY milestones
    ADD CONSTRAINT milestones_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES users(id);


--
-- Name: milestones milestones_project_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY milestones
    ADD CONSTRAINT milestones_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_project_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY notifications
    ADD CONSTRAINT notifications_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id);


--
-- Name: notifications notifications_user_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY notifications
    ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);


--
-- Name: opening_balances opening_balances_account_book_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY opening_balances
    ADD CONSTRAINT opening_balances_account_book_id_fkey FOREIGN KEY (account_book_id) REFERENCES account_books(id) ON DELETE CASCADE;


--
-- Name: opportunities opportunities_created_by_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY opportunities
    ADD CONSTRAINT opportunities_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);


--
-- Name: opportunities opportunities_owner_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY opportunities
    ADD CONSTRAINT opportunities_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES users(id);


--
-- Name: partner_contracts partner_contracts_partner_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY partner_contracts
    ADD CONSTRAINT partner_contracts_partner_id_fkey FOREIGN KEY (partner_id) REFERENCES partners(id) ON DELETE CASCADE;


--
-- Name: partners partners_created_by_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY partners
    ADD CONSTRAINT partners_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);


--
-- Name: partners partners_updated_by_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY partners
    ADD CONSTRAINT partners_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES users(id);


--
-- Name: progress_logs progress_logs_project_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY progress_logs
    ADD CONSTRAINT progress_logs_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: progress_logs progress_logs_task_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY progress_logs
    ADD CONSTRAINT progress_logs_task_id_fkey FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE;


--
-- Name: progress_logs progress_logs_user_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY progress_logs
    ADD CONSTRAINT progress_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);


--
-- Name: project_changes project_changes_by_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY project_changes
    ADD CONSTRAINT project_changes_by_id_fkey FOREIGN KEY (by_id) REFERENCES users(id);


--
-- Name: project_changes project_changes_project_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY project_changes
    ADD CONSTRAINT project_changes_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: project_members project_members_project_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY project_members
    ADD CONSTRAINT project_members_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: project_members project_members_user_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY project_members
    ADD CONSTRAINT project_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;


--
-- Name: project_receivable_payments project_receivable_payments_created_by_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY project_receivable_payments
    ADD CONSTRAINT project_receivable_payments_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);


--
-- Name: project_receivable_payments project_receivable_payments_deleted_by_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY project_receivable_payments
    ADD CONSTRAINT project_receivable_payments_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES users(id);


--
-- Name: project_receivable_payments project_receivable_payments_project_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY project_receivable_payments
    ADD CONSTRAINT project_receivable_payments_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT;


--
-- Name: project_receivables project_receivables_created_by_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY project_receivables
    ADD CONSTRAINT project_receivables_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);


--
-- Name: project_receivables project_receivables_deleted_by_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY project_receivables
    ADD CONSTRAINT project_receivables_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES users(id);


--
-- Name: project_receivables project_receivables_project_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY project_receivables
    ADD CONSTRAINT project_receivables_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT;


--
-- Name: projects projects_created_by_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY projects
    ADD CONSTRAINT projects_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);


--
-- Name: projects projects_dept_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY projects
    ADD CONSTRAINT projects_dept_id_fkey FOREIGN KEY (dept_id) REFERENCES departments(id);


--
-- Name: projects projects_owner_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY projects
    ADD CONSTRAINT projects_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES users(id);


--
-- Name: tasks tasks_owner_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY tasks
    ADD CONSTRAINT tasks_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES users(id);


--
-- Name: tasks tasks_parent_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY tasks
    ADD CONSTRAINT tasks_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES tasks(id);


--
-- Name: tasks tasks_predecessor_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY tasks
    ADD CONSTRAINT tasks_predecessor_id_fkey FOREIGN KEY (predecessor_id) REFERENCES tasks(id);


--
-- Name: tasks tasks_project_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY tasks
    ADD CONSTRAINT tasks_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: token_blacklist token_blacklist_user_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY token_blacklist
    ADD CONSTRAINT token_blacklist_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);


--
-- Name: user_modules user_modules_user_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY user_modules
    ADD CONSTRAINT user_modules_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;


--
-- Name: user_roles user_roles_role_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY user_roles
    ADD CONSTRAINT user_roles_role_id_fkey FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE;


--
-- Name: user_roles user_roles_user_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY user_roles
    ADD CONSTRAINT user_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;


--
-- Name: users users_dept_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY users
    ADD CONSTRAINT users_dept_id_fkey FOREIGN KEY (dept_id) REFERENCES departments(id);


--
-- Name: voucher_entries voucher_entries_voucher_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY voucher_entries
    ADD CONSTRAINT voucher_entries_voucher_id_fkey FOREIGN KEY (voucher_id) REFERENCES vouchers(id) ON DELETE CASCADE;


--
-- Name: voucher_templates voucher_templates_account_book_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY voucher_templates
    ADD CONSTRAINT voucher_templates_account_book_id_fkey FOREIGN KEY (account_book_id) REFERENCES account_books(id) ON DELETE CASCADE;


--
-- Name: voucher_templates voucher_templates_created_by_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY voucher_templates
    ADD CONSTRAINT voucher_templates_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);


--
-- Name: vouchers vouchers_account_book_id_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY vouchers
    ADD CONSTRAINT vouchers_account_book_id_fkey FOREIGN KEY (account_book_id) REFERENCES account_books(id) ON DELETE CASCADE;


--
-- Name: vouchers vouchers_created_by_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY vouchers
    ADD CONSTRAINT vouchers_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);


--
-- Name: vouchers vouchers_posted_by_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY vouchers
    ADD CONSTRAINT vouchers_posted_by_fkey FOREIGN KEY (posted_by) REFERENCES users(id);


--
-- Name: vouchers vouchers_reversal_of_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY vouchers
    ADD CONSTRAINT vouchers_reversal_of_fkey FOREIGN KEY (reversal_of) REFERENCES vouchers(id);


--
-- Name: vouchers vouchers_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY vouchers
    ADD CONSTRAINT vouchers_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES users(id);


--
-- Name: vouchers vouchers_voided_by_fkey; Type: FK CONSTRAINT; Schema: goose_export; Owner: -
--

ALTER TABLE ONLY vouchers
    ADD CONSTRAINT vouchers_voided_by_fkey FOREIGN KEY (voided_by) REFERENCES users(id);


--
-- PostgreSQL database dump complete
--

-- +goose Down
-- The current-schema baseline is irreversible; restore from a database backup.
-- +goose StatementBegin
DO $$
BEGIN
  RAISE EXCEPTION 'Goose baseline is irreversible; restore from backup';
END $$;
-- +goose StatementEnd
