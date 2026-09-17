import { describe, expect, it } from '@jest/globals';
import { parseEmbeddingResponse } from './embedding-response';
import { CHUNK_EMBEDDING_DIMENSIONS } from '../db/schema';

const vector = (fill: number, length = CHUNK_EMBEDDING_DIMENSIONS): number[] =>
  new Array<number>(length).fill(fill);

describe('parseEmbeddingResponse', () => {
  it('orders vectors by the reported index rather than response order', () => {
    const parsed = parseEmbeddingResponse(
      [
        { index: 1, embedding: vector(0.2) },
        { index: 0, embedding: vector(0.1) },
      ],
      2,
    );

    expect(parsed[0][0]).toBe(0.1);
    expect(parsed[1][0]).toBe(0.2);
  });

  it('rejects a response whose vector count differs from the input count', () => {
    expect(() =>
      parseEmbeddingResponse([{ index: 0, embedding: vector(0.1) }], 2),
    ).toThrow('returned 1 vectors for 2 inputs');
  });

  it('rejects a duplicate index instead of silently dropping an input', () => {
    // 중복을 허용하면 한 chunk의 벡터가 다른 chunk에도 저장됩니다.
    expect(() =>
      parseEmbeddingResponse(
        [
          { index: 0, embedding: vector(0.1) },
          { index: 0, embedding: vector(0.2) },
        ],
        2,
      ),
    ).toThrow('duplicate index 0');
  });

  it('rejects an index outside the input range', () => {
    expect(() =>
      parseEmbeddingResponse(
        [
          { index: 0, embedding: vector(0.1) },
          { index: 5, embedding: vector(0.2) },
        ],
        2,
      ),
    ).toThrow('out-of-range index 5');
  });

  it('rejects a non-integer index', () => {
    expect(() =>
      parseEmbeddingResponse([{ index: 0.5, embedding: vector(0.1) }], 1),
    ).toThrow('out-of-range index 0.5');
  });

  it('rejects a vector whose dimension does not match the column', () => {
    expect(() =>
      parseEmbeddingResponse([{ index: 0, embedding: vector(0.1, 1536) }], 1),
    ).toThrow(`1536-dimension vector; expected ${CHUNK_EMBEDDING_DIMENSIONS}`);
  });

  it('rejects an empty vector', () => {
    expect(() =>
      parseEmbeddingResponse([{ index: 0, embedding: [] }], 1),
    ).toThrow('empty vector');
  });

  it('rejects a payload that is not an array', () => {
    expect(() => parseEmbeddingResponse(undefined, 1)).toThrow(
      'returned 0 vectors for 1 inputs',
    );
  });

  it('rejects a vector containing a non-numeric value', () => {
    // 길이만 맞고 원소가 문자열이면 깨진 벡터 리터럴이 DB로 넘어갑니다.
    const broken = vector(0.1);
    broken[7] = 'oops' as unknown as number;

    expect(() =>
      parseEmbeddingResponse([{ index: 0, embedding: broken }], 1),
    ).toThrow('non-finite value at index 7');
  });

  it('rejects a vector containing NaN', () => {
    const broken = vector(0.1);
    broken[3] = Number.NaN;

    expect(() =>
      parseEmbeddingResponse([{ index: 0, embedding: broken }], 1),
    ).toThrow('non-finite value at index 3');
  });
});
