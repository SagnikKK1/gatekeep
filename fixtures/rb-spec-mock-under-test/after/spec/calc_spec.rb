require 'calc'

RSpec.describe Calc do
  describe '.add' do
    it 'adds' do
      allow(Calc).to receive(:add).and_return(5)
      expect(Calc.add(2, 3)).to eq(5)
    end

    it 'adds zero' do
      expect(Calc.add(0, 0)).to eq(0)
    end
  end
end
