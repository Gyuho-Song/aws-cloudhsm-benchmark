import { render, screen, fireEvent } from '@testing-library/react';
import MatrixSelector, { MatrixSubset } from './MatrixSelector';

test('emits a MatrixSubset of the expected shape on initial render', () => {
  let captured: MatrixSubset | null = null;
  render(<MatrixSelector onChange={(s) => { captured = s; }} />);
  // Toggle a checkbox to force one onChange emission
  fireEvent.click(screen.getByLabelText(/AES_128/));
  expect(captured).not.toBeNull();
  expect(captured!).toMatchObject({
    families: expect.any(Array),
    algorithms: expect.any(Array),
    modes: expect.any(Array),
    payloadBytes: expect.any(Array),
    clusterSizes: expect.any(Array),
    variants: expect.any(Array),
  });
});
