import crypto from 'crypto';
import { MerkleTree } from 'merkletreejs';
import Decimal from 'decimal.js';

// ============================================================
// CRYPTO SERVICE
// Implements hashing, Pedersen commitments (simulated with HMAC),
// Merkle trees, and range proof generation (placeholder for real ZK).
//
// NOTE: This is a production-structured implementation. For real ZK
// proofs, integrate Noir + bb (Barretenberg) or SP1 circuits.
// Pedersen commitments here use SHA-256+HMAC as a stand-in — the
// API is identical to a real Pedersen implementation.
// ============================================================

export interface PedersenCommitment {
  commitment: string; // hex-encoded commitment
  blindingFactor: string; // hex-encoded random blinding factor
}

export interface RangeProof {
  proof: Buffer;
  publicInputs: string[];
}

export interface MerkleProof {
  leaf: string;
  proof: Array<{ position: 'left' | 'right'; data: string }>;
  root: string;
}

export class CryptoService {
  /**
   * Compute deterministic hash of a journal entry
   */
  hashJournalEntry(entry: {
    id: string;
    entity_id: string;
    fiscal_period_id: string;
    entry_date: Date | string;
    total_debits: string;
    total_credits: string;
    lines: Array<{
      account_id: string;
      debit_amount: string | null;
      credit_amount: string | null;
    }>;
  }): string {
    const canonical = {
      id: entry.id,
      entity_id: entry.entity_id,
      fiscal_period_id: entry.fiscal_period_id,
      entry_date: entry.entry_date instanceof Date
        ? entry.entry_date.toISOString()
        : new Date(entry.entry_date).toISOString(),
      total_debits: entry.total_debits,
      total_credits: entry.total_credits,
      lines: entry.lines.map((l) => ({
        account_id: l.account_id,
        debit: l.debit_amount || '0',
        credit: l.credit_amount || '0',
      })),
    };

    return '0x' + crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  }

  /**
   * Create a Pedersen-style commitment to a value.
   * commit(value, r) = H(value || r)
   * In real Pedersen: commit(v, r) = v*G + r*H (elliptic curve points)
   */
  createCommitment(value: string | number): PedersenCommitment {
    const blindingFactor = crypto.randomBytes(32).toString('hex');
    const valueStr = typeof value === 'number' ? value.toString() : value;

    const commitment = crypto
      .createHmac('sha256', blindingFactor)
      .update(valueStr)
      .digest('hex');

    return {
      commitment: '0x' + commitment,
      blindingFactor: '0x' + blindingFactor,
    };
  }

  /**
   * Verify a commitment opens to the claimed value
   */
  verifyCommitment(commitment: string, value: string | number, blindingFactor: string): boolean {
    const valueStr = typeof value === 'number' ? value.toString() : value;
    const bf = blindingFactor.startsWith('0x') ? blindingFactor.slice(2) : blindingFactor;
    const expected = crypto
      .createHmac('sha256', bf)
      .update(valueStr)
      .digest('hex');
    const actual = commitment.startsWith('0x') ? commitment.slice(2) : commitment;
    return expected === actual;
  }

  /**
   * Generate a range proof that value is within [min, max].
   * Placeholder for real ZK range proof (Bulletproofs, PLONK).
   */
  generateRangeProof(
    value: string | number,
    blindingFactor: string,
    min: number = 0,
    max: number = Number.MAX_SAFE_INTEGER
  ): RangeProof {
    const valueNum = new Decimal(value);
    if (valueNum.lessThan(min) || valueNum.greaterThan(max)) {
      throw new Error(`Value ${value} out of range [${min}, ${max}]`);
    }

    // Real implementation would use bb/Noir circuit here.
    //
    // S1 (auditoría 2026-08-31): las claves _test_value/_test_bf que este
    // placeholder incluía «solo para verificación de pruebas» se persistían
    // en blockchain_attestations.range_proof y zkverify_proof — el compromiso
    // que promete no revelar el importe lo revelaba, junto con el blinding
    // factor que permite abrirlo. Cero consumidores las leían (ni las
    // pruebas). La migración 040 purga las filas ya escritas; un criterio
    // del plan vigila que no vuelvan.
    const proofData = {
      scheme: 'range_proof_v1',
      min,
      max,
      timestamp: Date.now(),
    };

    return {
      proof: Buffer.from(JSON.stringify(proofData)),
      publicInputs: [String(min), String(max)],
    };
  }

  /**
   * Verify a range proof (placeholder)
   */
  verifyRangeProof(proof: RangeProof, _commitment: string): boolean {
    try {
      const data = JSON.parse(proof.proof.toString());
      return data.scheme === 'range_proof_v1';
    } catch {
      return false;
    }
  }

  /**
   * Build a Merkle tree from leaf hashes
   */
  buildMerkleTree(leaves: string[]): MerkleTree {
    const bufLeaves = leaves.map((l) => {
      const hex = l.startsWith('0x') ? l.slice(2) : l;
      return Buffer.from(hex, 'hex');
    });

    return new MerkleTree(bufLeaves, this.sha256Buffer, { sortPairs: true });
  }

  private sha256Buffer = (data: Buffer): Buffer => {
    return crypto.createHash('sha256').update(data).digest();
  };

  /**
   * Get Merkle proof for a leaf
   */
  getMerkleProof(tree: MerkleTree, leaf: string): MerkleProof {
    const hex = leaf.startsWith('0x') ? leaf.slice(2) : leaf;
    const leafBuf = Buffer.from(hex, 'hex');
    const proof = tree.getProof(leafBuf);

    return {
      leaf: leaf,
      proof: proof.map((p) => ({
        position: (p.position as 'left' | 'right'),
        data: '0x' + p.data.toString('hex'),
      })),
      root: '0x' + tree.getRoot().toString('hex'),
    };
  }

  /**
   * Verify a Merkle proof
   */
  verifyMerkleProof(proof: MerkleProof): boolean {
    try {
      const hex = proof.leaf.startsWith('0x') ? proof.leaf.slice(2) : proof.leaf;
      const leafBuf = Buffer.from(hex, 'hex');
      const rootHex = proof.root.startsWith('0x') ? proof.root.slice(2) : proof.root;
      const rootBuf = Buffer.from(rootHex, 'hex');

      const proofElements = proof.proof.map((p) => ({
        position: p.position,
        data: Buffer.from(p.data.startsWith('0x') ? p.data.slice(2) : p.data, 'hex'),
      }));

      return MerkleTree.verify(proofElements, leafBuf, rootBuf, this.sha256Buffer, { sortPairs: true });
    } catch {
      return false;
    }
  }

  /**
   * Compute root only (without full tree storage)
   */
  computeMerkleRoot(leaves: string[]): string {
    if (leaves.length === 0) {
      return '0x' + Buffer.alloc(32).toString('hex');
    }
    const tree = this.buildMerkleTree(leaves);
    return '0x' + tree.getRoot().toString('hex');
  }

  /**
   * SHA-256 hex hash
   */
  sha256Hex(data: string | Buffer): string {
    return '0x' + crypto.createHash('sha256').update(data).digest('hex');
  }

  /**
   * Hash a value for dimensional aggregation
   */
  hashDimension(type: string, value: string): string {
    return this.sha256Hex(`${type}:${value}`);
  }
}

// Singleton
export const cryptoService = new CryptoService();
